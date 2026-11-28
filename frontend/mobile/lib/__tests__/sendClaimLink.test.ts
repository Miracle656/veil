import AsyncStorage from '@react-native-async-storage/async-storage';
import { Account, Horizon, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

import { ASSOCIATED_DOMAINS } from '../deepLinks';
import { reclaimEscrowSafely } from '../escrow';
import type { WalletSigner } from '../sendPayment';
import {
  BEARER_LINK_WARNING,
  MAX_CLAIM_LINK_NOTE_LENGTH,
  ONE_TIME_SHARE_WARNING,
  RECLAIM_DEVICE_KEY_WARNING,
  buildVerifiedClaimUrl,
  claimLinkWithSpendingAccount,
  createSenderClaimLink,
  estimateClaimLinkCost,
  hasSmartWalletFundedConfirmation,
  loadSenderClaimLinksOnChain,
  markSenderLinkReclaimed,
  markSmartWalletFundedConfirmation,
  resetClaimLinkIdempotencyForTests,
  resolveClaimLinkStellarAsset,
  retryReleaseClaimReserve,
  validateClaimLinkNote,
} from '../sendClaimLink';

const SENDER = Keypair.random();
const RECIPIENT = Keypair.random();
const USDC_ISSUER = Keypair.random().publicKey();
const BALANCE_ID = `00000000${'b'.repeat(64)}`;
const CB_CLAIMED = `00000000${'1'.repeat(64)}`;
const CB_RECLAIMED = `00000000${'2'.repeat(64)}`;
const CB_UNCLAIMED = `00000000${'3'.repeat(64)}`;
const CB_EXPIRED = `00000000${'4'.repeat(64)}`;
const NOW_UNIX = 1_760_100_000;

function makeSigner(kp: Keypair): WalletSigner {
  return {
    publicKey: kp.publicKey(),
    sign: (tx) => {
      tx.sign(kp);
    },
  };
}

describe('validateClaimLinkNote — phishing and markup lockdown (#1285)', () => {
  it('accepts empty notes and short plain-text messages', () => {
    expect(validateClaimLinkNote('')).toBeNull();
    expect(validateClaimLinkNote(undefined)).toBeNull();
    expect(validateClaimLinkNote('For lunch in Lekki')).toBeNull();
    expect(validateClaimLinkNote('a'.repeat(MAX_CLAIM_LINK_NOTE_LENGTH))).toBeNull();
  });

  it('refuses notes past the length cap', () => {
    expect(validateClaimLinkNote('a'.repeat(MAX_CLAIM_LINK_NOTE_LENGTH + 1))).toMatch(
      /80 characters/i,
    );
  });

  it.each([
    ['https URL', 'Claim bonus at https://evil.example/login'],
    ['http URL', 'Visit http://phish.org now'],
    ['www host', 'Verify at www.veil-support.com'],
    ['bare domain', 'Tap app.veil.xyz to double'],
    ['unlisted TLD (.page)', 'Claim bonus at veil-airdrop.page/login'],
    ['unlisted TLD (.support)', 'Reset PIN at veil.support/kyc'],
    ['Unicode dot confusable', 'Visit evil。com now'],
    ['protocol-relative URL', 'Open //evil.org/claim'],
    ['shortener domain', 'Open bit.ly/claim-now'],
    ['custom scheme', 'Open veil://send?to=GABC'],
    ['javascript URI', 'javascript:alert(1)'],
    ['IPv4 address', 'Go to 192.168.1.10/verify'],
  ])('refuses %s in a note', (_kind, input) => {
    expect(validateClaimLinkNote(input)).toMatch(/cannot include links|web addresses/i);
  });

  it.each([
    ['HTML tag', '<b>Urgent</b> verify wallet'],
    ['script tag', '<script>steal()</script>'],
    ['HTML entity', 'Click &amp; confirm'],
    ['Markdown link', '[Claim twice](spots)'],
    ['inline code backtick', 'Run `approve`'],
  ])('refuses %s markup in a note', (_kind, input) => {
    expect(validateClaimLinkNote(input)).toMatch(/no HTML|markup/i);
  });

  it('refuses control characters and embedded newlines', () => {
    expect(validateClaimLinkNote('Line 1\nLine 2')).toMatch(/line breaks|control/i);
  });
});

describe('resolveClaimLinkStellarAsset — refuses issued assets without a valid issuer (#1285)', () => {
  it('refuses an issued asset with null, empty, or malformed issuer instead of falling back to XLM', async () => {
    expect(() => resolveClaimLinkStellarAsset({ code: 'USDC', issuer: null })).toThrow(
      /without a valid Stellar issuer/i,
    );
    expect(() => resolveClaimLinkStellarAsset({ code: 'USDC', issuer: '' })).toThrow(
      /without a valid Stellar issuer/i,
    );
    expect(() => resolveClaimLinkStellarAsset({ code: 'USDC', issuer: 'not-a-g-key' })).toThrow(
      /without a valid Stellar issuer/i,
    );
    expect(() => resolveClaimLinkStellarAsset({ code: 'XLM', issuer: USDC_ISSUER })).toThrow(
      /Native XLM cannot specify/i,
    );

    const submitSpy = jest.spyOn(Horizon.Server.prototype, 'submitTransaction');
    await expect(
      createSenderClaimLink({
        confirmationId: 'missing_issuer_refused',
        signer: makeSigner(SENDER),
        amount: '25',
        asset: { code: 'USDC', issuer: null },
        nowUnix: NOW_UNIX,
      }),
    ).rejects.toThrow(/without a valid Stellar issuer/i);
    expect(submitSpy).not.toHaveBeenCalled();
    submitSpy.mockRestore();
  });

  it('preserves exact issued-asset code and valid G… issuer', () => {
    const resolved = resolveClaimLinkStellarAsset({ code: 'USDC', issuer: USDC_ISSUER });
    expect(resolved.assetCode).toBe('USDC');
    expect(resolved.assetIssuer).toBe(USDC_ISSUER);
    expect(resolved.stellarAsset.isNative()).toBe(false);
    expect(resolved.stellarAsset.getIssuer()).toBe(USDC_ISSUER);
  });
});

describe('estimateClaimLinkCost and warnings (#1285)', () => {
  it('shows amount, refundable 1 XLM reserve, exact network fee, and spending-key reclaim warning', () => {
    const xlmCost = estimateClaimLinkCost('12.5', 'XLM', '1000');
    expect(xlmCost).toEqual({
      amount: '12.5',
      assetCode: 'XLM',
      reserveXlm: '1',
      feeXlm: '0.0001',
      totalXlmRequired: '13.5001',
    });

    const usdcCost = estimateClaimLinkCost('50', 'USDC', '1000');
    expect(usdcCost).toEqual({
      amount: '50',
      assetCode: 'USDC',
      reserveXlm: '1',
      feeXlm: '0.0001',
      totalXlmRequired: '1.0001',
    });
    expect(BEARER_LINK_WARNING).toBe('Anyone with this link can claim it.');
    expect(RECLAIM_DEVICE_KEY_WARNING).toMatch(/spending key/i);
    expect(RECLAIM_DEVICE_KEY_WARNING).toMatch(/uninstalling/i);
    expect(ONE_TIME_SHARE_WARNING).toMatch(/cannot get the link back/i);
    expect(
      buildVerifiedClaimUrl({
        balanceId: BALANCE_ID,
        ephemeralSecret: SENDER.secret(),
        amount: '10',
        assetCode: 'XLM',
        assetIssuer: null,
        expiresAt: NOW_UNIX + 3_600,
        note: 'Coffee',
        network: 'mainnet',
      }),
    ).toContain('?network=mainnet&note=Coffee#s=');
  });
});

describe('createSenderClaimLink — idempotency, zero AsyncStorage secret, and end-to-end claimability (#1285)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    resetClaimLinkIdempotencyForTests();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('produces one link when double-tapped and never stores the bearer secret or claimUrl in AsyncStorage', async () => {
    jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockResolvedValue(
      new Account(SENDER.publicKey(), '300') as unknown as Horizon.AccountResponse,
    );
    const submitSpy = jest
      .spyOn(Horizon.Server.prototype, 'submitTransaction')
      .mockImplementation(async () => {
        await Promise.resolve();
        return {
          hash: 'tx_single_link',
          balance_id: BALANCE_ID,
        } as unknown as Horizon.HorizonApi.SubmitTransactionResponse;
      });

    const input = {
      confirmationId: 'confirm_session_1',
      signer: makeSigner(SENDER),
      amount: '15',
      note: 'Taxi split',
      nowUnix: NOW_UNIX,
    };

    const [first, second] = await Promise.all([
      createSenderClaimLink(input),
      createSenderClaimLink(input),
    ]);

    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(first.balanceId).toBe(BALANCE_ID);
    expect(second.balanceId).toBe(BALANCE_ID);
    expect(first.claimUrl).toBe(second.claimUrl);
    expect(
      first.claimUrl.startsWith(`https://${ASSOCIATED_DOMAINS[0]}/claim/${BALANCE_ID}?network=testnet`),
    ).toBe(true);

    const fragment = first.claimUrl.split('#')[1] ?? '';
    expect(fragment.startsWith('s=S')).toBe(true);
    const secretInFragment = decodeURIComponent(fragment.slice(2));

    // Verify AsyncStorage holds ONLY non-secret public metadata — no claimUrl and no secret seed.
    const rawStored = await AsyncStorage.getItem(
      `veil_created_claim_links_v1:${SENDER.publicKey()}`,
    );
    expect(rawStored).not.toBeNull();
    expect(rawStored).not.toContain(secretInFragment);
    expect(rawStored).not.toContain('#s=');
    expect(rawStored).not.toContain('claimUrl');
  });

  it('tracks smart-wallet step-1 funding per confirmationId and clears it once step 2 succeeds', async () => {
    markSmartWalletFundedConfirmation('confirm_sw_retry');
    expect(hasSmartWalletFundedConfirmation('confirm_sw_retry')).toBe(true);

    jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockResolvedValueOnce(
      new Account(SENDER.publicKey(), '350') as unknown as Horizon.AccountResponse,
    );
    jest.spyOn(Horizon.Server.prototype, 'submitTransaction').mockResolvedValueOnce({
      hash: 'tx_after_retry',
      balance_id: BALANCE_ID,
    } as unknown as Horizon.HorizonApi.SubmitTransactionResponse);

    await createSenderClaimLink({
      confirmationId: 'confirm_sw_retry',
      signer: makeSigner(SENDER),
      amount: '7.25',
      nowUnix: NOW_UNIX,
    });

    expect(hasSmartWalletFundedConfirmation('confirm_sw_retry')).toBe(false);
  });

  it('creates, shares, and claims end-to-end into the recipient Spending account via claimLinkWithSpendingAccount', async () => {
    let submittedCreateXdr = '';
    const submittedRecipientXdrs: string[] = [];

    jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockImplementation(async (pubKey: string) => {
      if (pubKey !== SENDER.publicKey() && pubKey !== RECIPIENT.publicKey()) {
        const err = new Error('Not Found') as Error & { response?: { status: number } };
        err.name = 'NotFoundError';
        err.response = { status: 404 };
        throw err;
      }
      const acct = new Account(pubKey, '400') as unknown as Horizon.AccountResponse;
      (acct as unknown as { balances: unknown[]; subentry_count: number }).balances = [
        { asset_type: 'native', balance: '25.0000000', selling_liabilities: '0.0000000' },
      ];
      (acct as unknown as { subentry_count: number }).subentry_count = 0;
      return acct;
    });

    jest
      .spyOn(Horizon.Server.prototype, 'submitTransaction')
      .mockImplementationOnce(async (tx) => {
        submittedCreateXdr = tx.toXDR();
        return {
          hash: 'tx_create_e2e',
          balance_id: BALANCE_ID,
        } as unknown as Horizon.HorizonApi.SubmitTransactionResponse;
      })
      .mockImplementation(async (tx) => {
        submittedRecipientXdrs.push(tx.toXDR());
        return {
          hash: `tx_recipient_${submittedRecipientXdrs.length}`,
        } as unknown as Horizon.HorizonApi.SubmitTransactionResponse;
      });

    const created = await createSenderClaimLink({
      confirmationId: 'confirm_e2e',
      signer: makeSigner(SENDER),
      amount: '20',
      note: 'Happy birthday',
      nowUnix: NOW_UNIX,
    });

    const fragment = created.claimUrl.split('#')[1] ?? '';
    const ephemeralSecret = decodeURIComponent(fragment.slice(2));
    const ephemeralKeypair = Keypair.fromSecret(ephemeralSecret);

    const createTx = TransactionBuilder.fromXDR(submittedCreateXdr, Networks.TESTNET);
    const createOp = createTx.operations[0] as Operation.CreateClaimableBalance;
    expect(createOp.claimants[0].destination).toBe(ephemeralKeypair.publicKey());

    jest.spyOn(Horizon.Server.prototype, 'claimableBalances').mockReturnValue({
      claimableBalance: () => ({
        call: async () => ({
          id: BALANCE_ID,
          asset: 'native',
          amount: '20.0000000',
          sponsor: SENDER.publicKey(),
          claimants: [
            { destination: ephemeralKeypair.publicKey(), predicate: { unconditional: true } },
            {
              destination: SENDER.publicKey(),
              predicate: { not: { abs_before_epoch: String(NOW_UNIX + 86_400) } },
            },
          ],
        }),
      }),
    } as unknown as ReturnType<Horizon.Server['claimableBalances']>);

    const claimOutcome = await claimLinkWithSpendingAccount({
      signer: makeSigner(RECIPIENT),
      balanceId: created.balanceId,
      ephemeralSecret,
    });

    expect(claimOutcome).toEqual({
      status: 'claimed',
      txHash: 'tx_recipient_1',
      mergeTxHash: 'tx_recipient_2',
      reserveReleased: true,
      reserveReleaseTxHash: 'tx_recipient_2',
      amount: '20.0000000',
      assetCode: 'XLM',
      assetIssuer: null,
    });
    expect(submittedRecipientXdrs).toHaveLength(2);
    const claimTx = TransactionBuilder.fromXDR(submittedRecipientXdrs[0], Networks.TESTNET);
    expect(claimTx.operations.map((op) => op.type)).toEqual([
      'beginSponsoringFutureReserves',
      'createAccount',
      'endSponsoringFutureReserves',
      'claimClaimableBalance',
      'payment',
    ]);
    const mergeTx = TransactionBuilder.fromXDR(submittedRecipientXdrs[1], Networks.TESTNET);
    expect(mergeTx.operations.map((op) => op.type)).toEqual(['accountMerge']);
  });

  it('sponsors a 0-XLM one-time account INSIDE the issued-asset claim+payment tx (zero 1.5 XLM bait-link window, zero op_seq_num_too_far) and merges on next ledger', async () => {
    const ephemeral = Keypair.random();
    const submittedXdrs: string[] = [];

    jest.spyOn(Horizon.Server.prototype, 'claimableBalances').mockReturnValueOnce({
      claimableBalance: () => ({
        call: async () => ({
          id: BALANCE_ID,
          asset: `USDC:${USDC_ISSUER}`,
          amount: '42.0000000',
          sponsor: SENDER.publicKey(),
          claimants: [{ destination: ephemeral.publicKey(), predicate: { unconditional: true } }],
        }),
      }),
    } as unknown as ReturnType<Horizon.Server['claimableBalances']>);

    jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockImplementation(async (pubKey: string) => {
      if (pubKey === ephemeral.publicKey()) {
        const err = new Error('Not Found') as Error & { response?: { status: number } };
        err.name = 'NotFoundError';
        err.response = { status: 404 };
        throw err;
      }
      const acct = new Account(pubKey, '600') as unknown as Horizon.AccountResponse;
      (acct as unknown as { balances: unknown[]; subentry_count: number }).balances = [
        { asset_type: 'native', balance: '20.0000000', selling_liabilities: '0.0000000' },
      ];
      (acct as unknown as { subentry_count: number }).subentry_count = 0;
      return acct;
    });

    jest.spyOn(Horizon.Server.prototype, 'submitTransaction').mockImplementation(async (tx) => {
      submittedXdrs.push(tx.toXDR());
      return {
        hash: `tx_issued_${submittedXdrs.length}`,
      } as unknown as Horizon.HorizonApi.SubmitTransactionResponse;
    });

    const res = await claimLinkWithSpendingAccount({
      signer: makeSigner(RECIPIENT),
      balanceId: BALANCE_ID,
      ephemeralSecret: ephemeral.secret(),
      linkNetwork: 'testnet',
    });

    expect(res).toEqual({
      status: 'claimed',
      txHash: 'tx_issued_1',
      mergeTxHash: 'tx_issued_2',
      reserveReleased: true,
      reserveReleaseTxHash: 'tx_issued_2',
      amount: '42.0000000',
      assetCode: 'USDC',
      assetIssuer: USDC_ISSUER,
    });
    expect(submittedXdrs).toHaveLength(2);
    const parsedClaim = TransactionBuilder.fromXDR(submittedXdrs[0], Networks.TESTNET);
    expect(parsedClaim.operations.map((op) => op.type)).toEqual([
      'changeTrust',
      'beginSponsoringFutureReserves',
      'createAccount',
      'changeTrust',
      'endSponsoringFutureReserves',
      'claimClaimableBalance',
      'payment',
      'changeTrust',
    ]);
    const parsedMerge = TransactionBuilder.fromXDR(submittedXdrs[1], Networks.TESTNET);
    expect(parsedMerge.operations.map((op) => op.type)).toEqual(['accountMerge']);
  });

  it('surfaces Tx 2 reserve-release failure instead of hiding it and lets retryReleaseClaimReserve complete the merge', async () => {
    const ephemeral = Keypair.random();

    jest.spyOn(Horizon.Server.prototype, 'claimableBalances').mockReturnValueOnce({
      claimableBalance: () => ({
        call: async () => ({
          id: BALANCE_ID,
          asset: 'native',
          amount: '12.0000000',
          sponsor: SENDER.publicKey(),
          claimants: [{ destination: ephemeral.publicKey(), predicate: { unconditional: true } }],
        }),
      }),
    } as unknown as ReturnType<Horizon.Server['claimableBalances']>);

    jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockImplementation(async (pubKey: string) => {
      if (pubKey === ephemeral.publicKey()) {
        const err = new Error('Not Found') as Error & { response?: { status: number } };
        err.name = 'NotFoundError';
        err.response = { status: 404 };
        throw err;
      }
      const acct = new Account(pubKey, '700') as unknown as Horizon.AccountResponse;
      (acct as unknown as { balances: unknown[]; subentry_count: number }).balances = [
        { asset_type: 'native', balance: '20.0000000', selling_liabilities: '0.0000000' },
      ];
      (acct as unknown as { subentry_count: number }).subentry_count = 0;
      return acct;
    });

    const submitSpy = jest
      .spyOn(Horizon.Server.prototype, 'submitTransaction')
      .mockResolvedValueOnce({
        hash: 'tx_claim_delivered',
      } as unknown as Horizon.HorizonApi.SubmitTransactionResponse)
      .mockRejectedValueOnce(new Error('Horizon 504 on accountMerge'))
      .mockResolvedValueOnce({
        hash: 'tx_merge_retry_ok',
      } as unknown as Horizon.HorizonApi.SubmitTransactionResponse);

    const claimOutcome = await claimLinkWithSpendingAccount({
      signer: makeSigner(RECIPIENT),
      balanceId: BALANCE_ID,
      ephemeralSecret: ephemeral.secret(),
      linkNetwork: 'testnet',
    });

    expect(claimOutcome).toEqual({
      status: 'claimed',
      txHash: 'tx_claim_delivered',
      mergeTxHash: null,
      reserveReleased: false,
      reserveReleaseError: 'Horizon 504 on accountMerge',
      amount: '12.0000000',
      assetCode: 'XLM',
      assetIssuer: null,
    });

    const retryOutcome = await retryReleaseClaimReserve({
      signer: makeSigner(RECIPIENT),
      ephemeralSecret: ephemeral.secret(),
    });
    expect(retryOutcome).toEqual({
      released: true,
      txHash: 'tx_merge_retry_ok',
    });
    expect(submitSpy).toHaveBeenCalledTimes(3);
  });
});

describe('loadSenderClaimLinksOnChain and unified reclaimEscrowSafely (#1285)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    resetClaimLinkIdempotencyForTests();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('scrubs any legacy claimUrl on read, reflects live Horizon state, and reclaims via reclaimEscrowSafely', async () => {
    await AsyncStorage.setItem(
      `veil_created_claim_links_v1:${SENDER.publicKey()}`,
      JSON.stringify([
        {
          balanceId: CB_CLAIMED,
          claimUrl: `https://app.useveilapp.xyz/claim/${CB_CLAIMED}#s=SLEGACYSECRET`,
          amount: '8',
          assetCode: 'XLM',
          assetIssuer: null,
          expiresAt: NOW_UNIX + 3_600,
          createdAt: NOW_UNIX - 600,
          note: 'Coffee',
        },
        {
          balanceId: CB_RECLAIMED,
          amount: '12',
          assetCode: 'XLM',
          assetIssuer: null,
          expiresAt: NOW_UNIX - 3_600,
          createdAt: NOW_UNIX - 7_200,
          note: null,
        },
      ]),
    );

    jest.spyOn(Horizon.Server.prototype, 'claimableBalances').mockReturnValue({
      sponsor: () => ({
        limit: () => ({
          order: () => ({
            call: async () => ({
              records: [
                {
                  id: CB_UNCLAIMED,
                  asset: 'native',
                  amount: '5.0000000',
                  sponsor: SENDER.publicKey(),
                  claimants: [
                    { destination: RECIPIENT.publicKey(), predicate: { unconditional: true } },
                    {
                      destination: SENDER.publicKey(),
                      predicate: { not: { abs_before_epoch: String(NOW_UNIX + 86_400) } },
                    },
                  ],
                },
                {
                  id: CB_EXPIRED,
                  asset: 'native',
                  amount: '9.0000000',
                  sponsor: SENDER.publicKey(),
                  claimants: [
                    { destination: RECIPIENT.publicKey(), predicate: { unconditional: true } },
                    {
                      destination: SENDER.publicKey(),
                      predicate: { not: { abs_before_epoch: String(NOW_UNIX - 10) } },
                    },
                  ],
                },
              ],
            }),
          }),
        }),
      }),
      claimableBalance: () => ({
        call: async () => ({
          id: CB_EXPIRED,
          asset: 'native',
          amount: '9.0000000',
          sponsor: SENDER.publicKey(),
          claimants: [
            { destination: RECIPIENT.publicKey(), predicate: { unconditional: true } },
            {
              destination: SENDER.publicKey(),
              predicate: { not: { abs_before_epoch: String(NOW_UNIX - 10) } },
            },
          ],
        }),
      }),
    } as unknown as ReturnType<Horizon.Server['claimableBalances']>);

    jest.spyOn(Horizon.Server.prototype, 'operations').mockImplementation(
      () =>
        ({
          forClaimableBalance: (id: string) => ({
            order: () => ({
              limit: () => ({
                call: async () => ({
                  records:
                    id === CB_RECLAIMED
                      ? [{ type: 'claim_claimable_balance', claimant: SENDER.publicKey() }]
                      : [{ type: 'claim_claimable_balance', claimant: RECIPIENT.publicKey() }],
                }),
              }),
            }),
          }),
        }) as unknown as ReturnType<Horizon.Server['operations']>,
    );

    const list = await loadSenderClaimLinksOnChain(SENDER.publicKey(), { nowUnix: NOW_UNIX });
    const byId = Object.fromEntries(list.map((i) => [i.balanceId, i]));

    // Legacy claimUrl secret was scrubbed out of AsyncStorage.
    const scrubbedRaw = await AsyncStorage.getItem(
      `veil_created_claim_links_v1:${SENDER.publicKey()}`,
    );
    expect(scrubbedRaw).not.toContain('SLEGACYSECRET');

    expect(byId[CB_UNCLAIMED].status).toBe('unclaimed');
    expect(byId[CB_UNCLAIMED].canReclaim).toBe(false);
    expect(byId[CB_EXPIRED].status).toBe('expired');
    expect(byId[CB_EXPIRED].canReclaim).toBe(true);
    expect(byId[CB_CLAIMED].status).toBe('claimed');
    expect(byId[CB_RECLAIMED].status).toBe('reclaimed');

    const preExpiry = await reclaimEscrowSafely({
      signer: makeSigner(SENDER),
      balanceId: CB_UNCLAIMED,
      expiresAt: NOW_UNIX + 86_400,
      nowUnix: NOW_UNIX,
    });
    expect(preExpiry.status).toBe('before_expiry');

    jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockResolvedValueOnce(
      new Account(SENDER.publicKey(), '500') as unknown as Horizon.AccountResponse,
    );
    jest.spyOn(Horizon.Server.prototype, 'submitTransaction').mockResolvedValueOnce({
      hash: 'tx_reclaimed_ok',
    } as unknown as Horizon.HorizonApi.SubmitTransactionResponse);

    const reclaimed = await reclaimEscrowSafely({
      signer: makeSigner(SENDER),
      balanceId: CB_EXPIRED,
      expiresAt: NOW_UNIX - 10,
      nowUnix: NOW_UNIX,
    });
    expect(reclaimed).toEqual({
      status: 'reclaimed',
      txHash: 'tx_reclaimed_ok',
      sweptReserveXlm: '1',
    });
    await markSenderLinkReclaimed(SENDER.publicKey(), CB_EXPIRED);
  });
});
