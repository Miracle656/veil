import AsyncStorage from '@react-native-async-storage/async-storage';
import { Account, Horizon, Keypair, Networks, StrKey, TransactionBuilder } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

import {
  CLAIM_ALREADY_CLAIMED_MESSAGE,
  CLAIM_STILL_WAITING_MESSAGE,
  MAX_SPONSORED_CLAIMS_PER_INSTALL,
  MAX_SPONSORED_CLAIM_XLM_PER_WALLET,
  clearPendingClaimCheckpoint,
  configureClaimFlowForTests,
  executeOneTapClaim,
  getPendingClaimResumeRoute,
  inspectClaimBeforePrompt,
  loadPendingClaimCheckpoint,
  sanitizeDisplayField,
} from '../claimFlow';
import { FEE_PAYER_SOURCE_KEY } from '../feePayerSource';
import { setNetwork } from '../network';
import { getSignerSecret, getWalletAddress, hasUsableWallet } from '../walletStore';

const mockSecureStore = new Map<string, string>();
const mockEvaluatePrf = jest.fn();
const mockRequirePasskey = jest.fn(async () => undefined);
const mockFundWithFriendbot = jest.fn<Promise<boolean>, [string]>(async () => true);

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) =>
    mockSecureStore.has(key) ? mockSecureStore.get(key)! : null,
  ),
  setItemAsync: jest.fn(async (key: string, val: string) => {
    mockSecureStore.set(key, val);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockSecureStore.delete(key);
  }),
}));

jest.mock('../passkey', () => ({
  evaluatePrf: (...args: unknown[]) => mockEvaluatePrf(...args),
  requirePasskey: () => mockRequirePasskey(),
}));

jest.mock('../classicWallet', () => ({
  fundWithFriendbot: (addr: string) => mockFundWithFriendbot(addr),
}));

jest.mock('../walletBreadcrumbs', () => ({
  writeBreadcrumbs: jest.fn(async () => undefined),
}));

const SENDER = Keypair.random();
const EPHEMERAL = Keypair.random();
const USDC_ISSUER = Keypair.random().publicKey();
const BALANCE_ID = `00000000${'d'.repeat(64)}`;
const CONTRACT_ADDR = StrKey.encodeContract(Buffer.alloc(32, 7));
const PUBKEY_BYTES = new Uint8Array(65);
PUBKEY_BYTES[0] = 0x04;
PUBKEY_BYTES.fill(0xab, 1);

const PRF_SEED = new Uint8Array(32).fill(0x42);
const EXPECTED_FEE_PAYER = Keypair.fromRawEd25519Seed(Buffer.from(PRF_SEED));

function makeNotFound() {
  const err = new Error('Not Found') as Error & { response?: { status: number } };
  err.name = 'NotFoundError';
  err.response = { status: 404 };
  return err;
}

function mockOpenClaimableBalance(asset = 'native', amount = '25.0000000') {
  jest.spyOn(Horizon.Server.prototype, 'claimableBalances').mockReturnValue({
    claimableBalance: () => ({
      call: async () => ({
        id: BALANCE_ID,
        asset,
        amount,
        sponsor: SENDER.publicKey(),
        claimants: [
          { destination: EPHEMERAL.publicKey(), predicate: { unconditional: true } },
          {
            destination: SENDER.publicKey(),
            predicate: { not: { abs_before_epoch: '1900000000' } },
          },
        ],
      }),
    }),
  } as unknown as ReturnType<Horizon.Server['claimableBalances']>);
}

function mockHorizonAccountsAndSubmit(txHash = 'tx_claim_1284') {
  let seq = 100;
  jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockImplementation(async (pubKey: string) => {
    seq += 1;
    const acct = new Account(pubKey, String(seq)) as unknown as Horizon.AccountResponse;
    (acct as unknown as { balances: unknown[] }).balances = [
      { asset_type: 'native', balance: '100.0000000' },
    ];
    return acct;
  });

  const submittedXdrs: string[] = [];
  const submitSpy = jest
    .spyOn(Horizon.Server.prototype, 'submitTransaction')
    .mockImplementation(async (tx) => {
      const xdrStr = tx.toXDR();
      // Enforce Stellar Core's `ACCOUNT_MERGE_SEQNUM_TOO_FAR` (`op_seq_num_too_far`)
      // protocol rule: creating an account and merging it in the same ledger/tx fails!
      const parsed = TransactionBuilder.fromXDR(xdrStr, Networks.TESTNET);
      const ops = 'operations' in parsed ? parsed.operations : [];
      const created = new Set(
        ops
          .filter((o) => o.type === 'createAccount')
          .map((o) => (o as { destination?: string }).destination),
      );
      for (const op of ops) {
        if (op.type === 'accountMerge' && created.has(op.source)) {
          throw new Error('Stellar Core protocol error: op_seq_num_too_far');
        }
      }
      submittedXdrs.push(xdrStr);
      return {
        hash: submittedXdrs.length === 1 ? txHash : `${txHash}_merge`,
      } as unknown as Horizon.HorizonApi.SubmitTransactionResponse;
    });

  return {
    submitSpy,
    getSubmittedXdr: () => submittedXdrs[0] ?? '',
    getSubmittedXdrs: () => submittedXdrs,
  };
}

describe('one-tap claim onboarding on a fresh install (#1284)', () => {
  beforeEach(async () => {
    mockSecureStore.clear();
    await AsyncStorage.clear();
    jest.clearAllMocks();
    jest.restoreAllMocks();
    configureClaimFlowForTests({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('onboards an install with no wallet into a funded, PRF-recoverable wallet and claims in one action', async () => {
    expect(await hasUsableWallet()).toBe(false);

    mockOpenClaimableBalance(`USDC:${USDC_ISSUER}`, '40.0000000');
    const { submitSpy, getSubmittedXdrs } = mockHorizonAccountsAndSubmit('tx_usdc_claimed');

    // 1. Preview before any prompt: shows amount, asset, sender, and saves deferred resume route.
    const preview = await inspectClaimBeforePrompt({
      balanceId: BALANCE_ID,
      sender: 'Amaka',
      note: 'Welcome to Lagos',
      ephemeralSecret: EPHEMERAL.secret(),
    });
    expect(preview).toMatchObject({
      status: 'ready',
      amount: '40',
      assetCode: 'USDC',
      assetIssuer: USDC_ISSUER,
      senderLabel: 'Amaka',
      note: 'Welcome to Lagos',
      hasExistingWallet: false,
    });
    expect(await getPendingClaimResumeRoute()).toContain(`id=${BALANCE_ID}`);

    // 2. One tap registers passkey, verifies PRF, funds fee-payer, adds USDC trustline,
    //    sponsors ephemeral claimant, claims, transfers, and merges ephemeral away.
    const registerSpy = jest.fn(async () => {
      await AsyncStorage.setItem('invisible_wallet_key_id', 'cred_fresh_1');
      return { walletAddress: CONTRACT_ADDR, publicKeyBytes: PUBKEY_BYTES };
    });
    mockEvaluatePrf.mockResolvedValue({ outcome: 'ok', output: PRF_SEED });

    const result = await executeOneTapClaim(
      { register: registerSpy },
      {
        balanceId: BALANCE_ID,
        amount: '40',
        assetCode: 'USDC',
        assetIssuer: USDC_ISSUER,
        ephemeralSecret: EPHEMERAL.secret(),
      },
    );

    expect(result).toEqual({
      status: 'claimed',
      txHash: 'tx_usdc_claimed',
      walletAddress: CONTRACT_ADDR,
      feePayerAddress: EXPECTED_FEE_PAYER.publicKey(),
      amount: '40',
      assetCode: 'USDC',
      createdNewWallet: true,
    });

    // Wallet is now fully usable and bound to PRF (never a random fee payer).
    expect(await hasUsableWallet()).toBe(true);
    expect(await getWalletAddress()).toBe(CONTRACT_ADDR);
    expect(await getSignerSecret()).toBe(EXPECTED_FEE_PAYER.secret());
    expect(JSON.parse((await AsyncStorage.getItem(FEE_PAYER_SOURCE_KEY)) ?? '{}')).toEqual({
      address: EXPECTED_FEE_PAYER.publicKey(),
      source: 'prf',
    });
    expect(await loadPendingClaimCheckpoint()).toBeNull();
    expect(submitSpy).toHaveBeenCalledTimes(2);

    const [claimXdr, mergeXdr] = getSubmittedXdrs();
    const parsedClaimTx = TransactionBuilder.fromXDR(claimXdr, Networks.TESTNET);
    expect('operations' in parsedClaimTx && parsedClaimTx.operations.map((o) => o.type)).toEqual([
      'changeTrust',
      'beginSponsoringFutureReserves',
      'createAccount',
      'changeTrust',
      'endSponsoringFutureReserves',
      'claimClaimableBalance',
      'payment',
      'changeTrust',
    ]);
    expect(parsedClaimTx.signatures).toHaveLength(2);

    const parsedMergeTx = TransactionBuilder.fromXDR(mergeXdr, Networks.TESTNET);
    expect('operations' in parsedMergeTx && parsedMergeTx.operations.map((o) => o.type)).toEqual([
      'accountMerge',
    ]);
    expect(parsedMergeTx.signatures).toHaveLength(2);
  });

  it('scopes SDK passkey keys on mainnet (_mainnet) and strips phishing bare domains from notes', async () => {
    await setNetwork('mainnet');
    try {
      expect(sanitizeDisplayField('Finish KYC at veil-verify.com/login', 80)).toBeNull();
      expect(sanitizeDisplayField('Claim bonus at evil.page', 80)).toBeNull();
      expect(sanitizeDisplayField('Visit evil。com now', 80)).toBeNull();
      expect(sanitizeDisplayField('Contact support@evil.org', 80)).toBeNull();
      expect(sanitizeDisplayField('Lunch $12.50, thanks!', 80)).toBe('Lunch $12.50, thanks!');

      mockOpenClaimableBalance('native', '8.0000000');
      const sponsorFetch = jest.fn(async () => ({ ok: true, status: 200 }) as Response);
      configureClaimFlowForTests({
        fetchImpl: sponsorFetch,
        sponsorEndpointUrl: 'https://app.useveilapp.xyz/api/sponsor-claim',
      });

      let seq = 500;
      jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockImplementation(async (pubKey: string) => {
        seq += 1;
        const acct = new Account(pubKey, String(seq)) as unknown as Horizon.AccountResponse;
        (acct as unknown as { balances: unknown[] }).balances = [
          { asset_type: 'native', balance: '5.0000000' },
        ];
        return acct;
      });
      jest.spyOn(Horizon.Server.prototype, 'submitTransaction').mockResolvedValue({
        hash: 'tx_mainnet_claim',
      } as unknown as Horizon.HorizonApi.SubmitTransactionResponse);

      // 1. Non-PRF passkey on mainnet clears `_mainnet` SDK keys so retry does not hit excludeCredentials.
      const nonPrfRegister = jest.fn(async () => {
        await AsyncStorage.setItem('invisible_wallet_key_id_mainnet', 'cred_mainnet_bad');
        await AsyncStorage.setItem('invisible_wallet_address_mainnet', CONTRACT_ADDR);
        return { walletAddress: CONTRACT_ADDR, publicKeyBytes: PUBKEY_BYTES };
      });
      mockEvaluatePrf.mockResolvedValueOnce({ outcome: 'unsupported' });

      const refused = await executeOneTapClaim(
        { register: nonPrfRegister },
        { balanceId: BALANCE_ID, amount: '8', assetCode: 'XLM', ephemeralSecret: EPHEMERAL.secret() },
      );
      expect(refused.status).toBe('prf_unsupported');
      expect(await AsyncStorage.getItem('invisible_wallet_key_id_mainnet')).toBeNull();
      expect(await AsyncStorage.getItem('invisible_wallet_address_mainnet')).toBeNull();

      // 2. Retrying with a PRF-capable passkey on mainnet reads `invisible_wallet_key_id_mainnet` and succeeds.
      const prfRegister = jest.fn(async () => {
        await AsyncStorage.setItem('invisible_wallet_key_id_mainnet', 'cred_mainnet_ok');
        return { walletAddress: CONTRACT_ADDR, publicKeyBytes: PUBKEY_BYTES };
      });
      mockEvaluatePrf.mockResolvedValueOnce({ outcome: 'ok', output: PRF_SEED });

      const claimed = await executeOneTapClaim(
        { register: prfRegister },
        { balanceId: BALANCE_ID, amount: '8', assetCode: 'XLM', ephemeralSecret: EPHEMERAL.secret() },
      );
      expect(claimed).toMatchObject({
        status: 'claimed',
        walletAddress: CONTRACT_ADDR,
        amount: '8',
        assetCode: 'XLM',
      });
    } finally {
      await setNetwork('testnet');
    }
  });

  it('refuses explicitly when the authenticator has no PRF support instead of stranding a random fee payer', async () => {
    mockOpenClaimableBalance('native', '15.0000000');
    const submitSpy = jest.spyOn(Horizon.Server.prototype, 'submitTransaction');

    const registerSpy = jest.fn(async () => {
      await AsyncStorage.setItem('invisible_wallet_key_id', 'cred_no_prf');
      return { walletAddress: CONTRACT_ADDR, publicKeyBytes: PUBKEY_BYTES };
    });
    mockEvaluatePrf.mockResolvedValue({ outcome: 'unsupported' });

    const result = await executeOneTapClaim(
      { register: registerSpy },
      { balanceId: BALANCE_ID, amount: '15', assetCode: 'XLM' },
    );

    expect(result.status).toBe('prf_unsupported');
    if (result.status === 'prf_unsupported') {
      expect(result.message).toMatch(/does not support WebAuthn PRF/i);
      expect(result.message).toMatch(/still waiting/i);
    }

    // No random fee payer or half-stranded wallet was committed, and nothing was submitted.
    expect(await hasUsableWallet()).toBe(false);
    expect(await getWalletAddress()).toBeNull();
    expect(await getSignerSecret()).toBeNull();
    expect(submitSpy).not.toHaveBeenCalled();

    // Pending claim remains intact so the user can retry with a PRF-capable provider.
    const checkpoint = await loadPendingClaimCheckpoint();
    expect(checkpoint?.stage).toBe('before_passkey');
    expect(checkpoint?.link.balanceId).toBe(BALANCE_ID);
  });

  it('states plainly when a link was already claimed rather than failing with a network error', async () => {
    jest.spyOn(Horizon.Server.prototype, 'claimableBalances').mockReturnValue({
      claimableBalance: () => ({
        call: async () => {
          throw makeNotFound();
        },
      }),
    } as unknown as ReturnType<Horizon.Server['claimableBalances']>);
    jest.spyOn(Horizon.Server.prototype, 'operations').mockReturnValue({
      forClaimableBalance: () => ({
        order: () => ({
          limit: () => ({
            call: async () => ({
              records: [{ type: 'claim_claimable_balance', claimant: Keypair.random().publicKey() }],
            }),
          }),
        }),
      }),
    } as unknown as ReturnType<Horizon.Server['operations']>);

    const preview = await inspectClaimBeforePrompt({ balanceId: BALANCE_ID });
    expect(preview).toEqual({
      status: 'already_claimed',
      balanceId: BALANCE_ID,
      message: CLAIM_ALREADY_CLAIMED_MESSAGE,
    });
  });

  it('enforces the Veil fee-payer sponsorship cap when Friendbot is unavailable', async () => {
    mockOpenClaimableBalance('native', '10.0000000');
    mockFundWithFriendbot.mockResolvedValue(false);

    // Fee payer does not exist on chain yet -> triggers Veil sponsor endpoint.
    jest
      .spyOn(Horizon.Server.prototype, 'loadAccount')
      .mockRejectedValueOnce(makeNotFound())
      .mockResolvedValue(
        new Account(EXPECTED_FEE_PAYER.publicKey(), '1') as unknown as Horizon.AccountResponse,
      );
    jest.spyOn(Horizon.Server.prototype, 'submitTransaction').mockResolvedValue({
      hash: 'tx_sponsored_claim',
    } as unknown as Horizon.HorizonApi.SubmitTransactionResponse);

    const sponsorFetch = jest.fn(async () => ({ ok: true, status: 200 }) as Response);
    configureClaimFlowForTests({
      fetchImpl: sponsorFetch,
      sponsorEndpointUrl: 'https://app.useveilapp.xyz/api/sponsor-claim',
    });

    const registerSpy = jest.fn(async () => {
      await AsyncStorage.setItem('invisible_wallet_key_id', 'cred_sponsored');
      return { walletAddress: CONTRACT_ADDR, publicKeyBytes: PUBKEY_BYTES };
    });
    mockEvaluatePrf.mockResolvedValue({ outcome: 'ok', output: PRF_SEED });

    const first = await executeOneTapClaim(
      { register: registerSpy },
      { balanceId: BALANCE_ID, amount: '10', assetCode: 'XLM' },
    );
    expect(first.status).toBe('claimed');
    expect(sponsorFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (sponsorFetch.mock.calls[0] as unknown as [string, { body: string }])[1].body,
    ) as { maxXlm: string };
    expect(body.maxXlm).toBe(MAX_SPONSORED_CLAIM_XLM_PER_WALLET);
    expect(MAX_SPONSORED_CLAIMS_PER_INSTALL).toBe(1);
  });
});

describe('resumability across every interruption boundary (#1284)', () => {
  beforeEach(async () => {
    mockSecureStore.clear();
    await AsyncStorage.clear();
    jest.clearAllMocks();
    jest.restoreAllMocks();
    mockFundWithFriendbot.mockResolvedValue(true);
    configureClaimFlowForTests({});
  });

  afterEach(async () => {
    await clearPendingClaimCheckpoint();
    jest.restoreAllMocks();
  });

  it('1. resumes cleanly when interrupted BEFORE the passkey completes', async () => {
    mockOpenClaimableBalance('native', '12.0000000');
    mockHorizonAccountsAndSubmit('tx_resumed_step1');

    const registerSpy = jest
      .fn()
      .mockRejectedValueOnce(new Error('Hardware biometric sensor busy'))
      .mockImplementationOnce(async () => {
        await AsyncStorage.setItem('invisible_wallet_key_id', 'cred_step1');
        return { walletAddress: CONTRACT_ADDR, publicKeyBytes: PUBKEY_BYTES };
      });
    mockEvaluatePrf.mockResolvedValue({ outcome: 'ok', output: PRF_SEED });

    await expect(
      executeOneTapClaim(
        { register: registerSpy },
        { balanceId: BALANCE_ID, amount: '12', assetCode: 'XLM' },
      ),
    ).rejects.toThrow(/biometric sensor busy/i);

    const reopened = await inspectClaimBeforePrompt({ balanceId: BALANCE_ID });
    expect(reopened.status).toBe('ready');
    if (reopened.status === 'ready') {
      expect(reopened.resumingStage).toBe('before_passkey');
      expect(reopened.resumeNotice).toBe(CLAIM_STILL_WAITING_MESSAGE);
    }

    const resumed = await executeOneTapClaim(
      { register: registerSpy },
      { balanceId: BALANCE_ID, amount: '12', assetCode: 'XLM' },
    );
    expect(resumed.status).toBe('claimed');
  });

  it('2. resumes cleanly when interrupted AFTER the passkey without calling register() a second time', async () => {
    mockOpenClaimableBalance('native', '18.0000000');
    mockHorizonAccountsAndSubmit('tx_resumed_step2');

    const registerSpy = jest.fn(async () => {
      await AsyncStorage.setItem('invisible_wallet_key_id', 'cred_step2');
      return { walletAddress: CONTRACT_ADDR, publicKeyBytes: PUBKEY_BYTES };
    });
    // Both initial PRF attempts fail transiently -> interrupted at `after_passkey`.
    mockEvaluatePrf
      .mockResolvedValueOnce({ outcome: 'failed' })
      .mockResolvedValueOnce({ outcome: 'failed' })
      .mockResolvedValueOnce({ outcome: 'ok', output: PRF_SEED });

    await expect(
      executeOneTapClaim(
        { register: registerSpy },
        { balanceId: BALANCE_ID, amount: '18', assetCode: 'XLM' },
      ),
    ).rejects.toThrow(/still waiting/i);

    expect((await loadPendingClaimCheckpoint())?.stage).toBe('after_passkey');
    expect(registerSpy).toHaveBeenCalledTimes(1);

    // Reopen and finish: register() MUST NOT be called again (preserving the passkey ID).
    const resumed = await executeOneTapClaim(
      { register: registerSpy },
      { balanceId: BALANCE_ID, amount: '18', assetCode: 'XLM' },
    );
    expect(resumed.status).toBe('claimed');
    expect(registerSpy).toHaveBeenCalledTimes(1);
  });

  it('3. resumes cleanly when interrupted AFTER wallet creation (during fee-payer funding)', async () => {
    mockOpenClaimableBalance('native', '22.0000000');
    let fundedYet = false;
    jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockImplementation(async (pubKey: string) => {
      if (!fundedYet) throw makeNotFound();
      const acct = new Account(pubKey, '10') as unknown as Horizon.AccountResponse;
      (acct as unknown as { balances: unknown[] }).balances = [
        { asset_type: 'native', balance: '100.0000000' },
      ];
      return acct;
    });
    jest.spyOn(Horizon.Server.prototype, 'submitTransaction').mockResolvedValue({
      hash: 'tx_resumed_step3',
    } as unknown as Horizon.HorizonApi.SubmitTransactionResponse);

    mockFundWithFriendbot.mockResolvedValueOnce(false).mockImplementationOnce(async () => {
      fundedYet = true;
      return true;
    });
    configureClaimFlowForTests({ sponsorEndpointUrl: null });

    const registerSpy = jest.fn(async () => {
      await AsyncStorage.setItem('invisible_wallet_key_id', 'cred_step3');
      return { walletAddress: CONTRACT_ADDR, publicKeyBytes: PUBKEY_BYTES };
    });
    mockEvaluatePrf.mockResolvedValue({ outcome: 'ok', output: PRF_SEED });

    await expect(
      executeOneTapClaim(
        { register: registerSpy },
        { balanceId: BALANCE_ID, amount: '22', assetCode: 'XLM' },
      ),
    ).rejects.toThrow(/still waiting/i);

    expect(await hasUsableWallet()).toBe(true);
    expect((await loadPendingClaimCheckpoint())?.stage).toBe('after_creation');

    // Resume: wallet already exists, skips register(), funds fee-payer, settles claim!
    const resumed = await executeOneTapClaim(
      { register: registerSpy },
      { balanceId: BALANCE_ID, amount: '22', assetCode: 'XLM' },
    );
    expect(resumed.status).toBe('claimed');
    expect(registerSpy).toHaveBeenCalledTimes(1);
  });

  it('4. resumes cleanly when interrupted DURING claim submission', async () => {
    mockOpenClaimableBalance('native', '30.0000000');
    let seq = 20;
    jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockImplementation(async (pubKey: string) => {
      seq += 1;
      const acct = new Account(pubKey, String(seq)) as unknown as Horizon.AccountResponse;
      (acct as unknown as { balances: unknown[] }).balances = [
        { asset_type: 'native', balance: '100.0000000' },
      ];
      return acct;
    });
    jest
      .spyOn(Horizon.Server.prototype, 'submitTransaction')
      .mockRejectedValueOnce(new Error('Network socket disconnected'))
      .mockResolvedValueOnce({
        hash: 'tx_resumed_step4',
      } as unknown as Horizon.HorizonApi.SubmitTransactionResponse);

    const registerSpy = jest.fn(async () => {
      await AsyncStorage.setItem('invisible_wallet_key_id', 'cred_step4');
      return { walletAddress: CONTRACT_ADDR, publicKeyBytes: PUBKEY_BYTES };
    });
    mockEvaluatePrf.mockResolvedValue({ outcome: 'ok', output: PRF_SEED });

    await expect(
      executeOneTapClaim(
        { register: registerSpy },
        { balanceId: BALANCE_ID, amount: '30', assetCode: 'XLM' },
      ),
    ).rejects.toThrow(/still waiting/i);

    expect((await loadPendingClaimCheckpoint())?.stage).toBe('during_claim');

    const resumed = await executeOneTapClaim(
      { register: registerSpy },
      { balanceId: BALANCE_ID, amount: '30', assetCode: 'XLM' },
    );
    expect(resumed).toMatchObject({
      status: 'claimed',
      txHash: 'tx_resumed_step4',
      amount: '30',
      assetCode: 'XLM',
    });
    expect(await loadPendingClaimCheckpoint()).toBeNull();
  });
});
