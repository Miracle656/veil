import AsyncStorage from '@react-native-async-storage/async-storage';
import { Horizon, Keypair } from '@stellar/stellar-sdk';
import * as SecureStore from 'expo-secure-store';

import {
  CLAIM_MAINNET_SPONSOR_UNAVAILABLE_MESSAGE,
  MAX_SPONSORED_CLAIM_XLM_PER_WALLET,
  PENDING_CLAIM_TTL_MS,
  clearPendingClaimCheckpoint,
  createWalletAndClaim,
  dismissPendingClaim,
  ensureClaimFeePayerFunded,
  getClaimSponsorEndpoint,
  getPendingClaimResumeRoute,
  isClaimSponsorshipAvailable,
  loadPendingClaimCheckpoint,
  requiredClaimFeePayerXlm,
  resetClaimFlowMemoryForTests,
  resolveSettledClaimOnChain,
  resumeInterruptedClaimOnChain,
  retryPendingPrfAndClaim,
  savePendingClaimCheckpoint,
  signInAndClaim,
  type PendingPrfWallet,
} from '../claimFlow';
import { USDC_TESTNET_ISSUER } from '../assets';
import { clearClaimLinkSecret, peekClaimLinkSecret, resolveDeepLink } from '../deepLinks';
import { setNetwork } from '../network';
import type { OpenerLinkInspection } from '../escrow';

const mockSecureMap = new Map<string, string>();
const mockCreatePasskeyWallet = jest.fn();
const mockLoginWithPasskey = jest.fn();
const mockEvaluatePrf = jest.fn();
const mockFundWithFriendbot = jest.fn();
const mockHasUsableWallet = jest.fn();
const mockRequireSigner = jest.fn();
const mockInspectClaimLink = jest.fn();
const mockClaimLinkWithSpending = jest.fn();
const mockRetryReleaseReserve = jest.fn();

const mockLoadAccount = jest.fn();
const mockForClaimableBalanceCall = jest.fn();
const mockForTransactionCall = jest.fn();
const mockTransactionCall = jest.fn();

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: jest.fn(() => ({
        loadAccount: (...args: unknown[]) => mockLoadAccount(...args),
        operations: () => ({
          forClaimableBalance: () => ({
            order: () => ({
              limit: () => ({
                call: () => mockForClaimableBalanceCall(),
              }),
            }),
          }),
          forTransaction: () => ({
            limit: () => ({
              call: () => mockForTransactionCall(),
            }),
          }),
        }),
        transactions: () => ({
          transaction: () => ({
            call: () => mockTransactionCall(),
          }),
        }),
      })),
    },
  };
});

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => (mockSecureMap.has(key) ? mockSecureMap.get(key)! : null)),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockSecureMap.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockSecureMap.delete(key);
  }),
}));

jest.mock('../passkeyWallet', () => {
  const actual = jest.requireActual('../passkeyWallet');
  return {
    ...actual,
    createPasskeyWallet: (...args: unknown[]) => mockCreatePasskeyWallet(...args),
  };
});

jest.mock('../passkeyLogin', () => ({
  loginWithPasskey: (...args: unknown[]) => mockLoginWithPasskey(...args),
}));

jest.mock('../passkey', () => ({
  evaluatePrf: (...args: unknown[]) => mockEvaluatePrf(...args),
}));

jest.mock('../classicWallet', () => ({
  fundWithFriendbot: (...args: unknown[]) => mockFundWithFriendbot(...args),
}));

jest.mock('../walletStore', () => ({
  hasUsableWallet: (...args: unknown[]) => mockHasUsableWallet(...args),
}));

jest.mock('../signer', () => ({
  requireSigner: (...args: unknown[]) => mockRequireSigner(...args),
}));

jest.mock('../escrow', () => {
  const actual = jest.requireActual('../escrow');
  return {
    ...actual,
    inspectClaimLinkForOpener: (...args: unknown[]) => mockInspectClaimLink(...args),
  };
});

jest.mock('../sendClaimLink', () => {
  const actual = jest.requireActual('../sendClaimLink');
  return {
    ...actual,
    claimLinkWithSpendingAccount: (...args: unknown[]) => mockClaimLinkWithSpending(...args),
    retryReleaseClaimReserve: (...args: unknown[]) => mockRetryReleaseReserve(...args),
  };
});

const mockRecipient = Keypair.random();
const mockEphemeral = Keypair.random();
const mockSender = Keypair.random();
const mockOtherUser = Keypair.random();

function notFoundError(): Error & { response: { status: number } } {
  const err = new Error('Not Found') as Error & { response: { status: number } };
  err.name = 'NotFoundError';
  err.response = { status: 404 };
  return err;
}

function makeAccount(
  xlmBalance: string,
  opts: {
    subentries?: number;
    numSponsoring?: number;
    numSponsored?: number;
    trustlines?: { code: string; issuer: string; balance?: string }[];
  } = {},
) {
  return {
    subentry_count: opts.subentries ?? 0,
    num_sponsoring: opts.numSponsoring ?? 0,
    num_sponsored: opts.numSponsored ?? 0,
    balances: [
      { asset_type: 'native', balance: xlmBalance },
      ...(opts.trustlines ?? []).map((t) => ({
        asset_type: 'credit_alphanum4',
        asset_code: t.code,
        asset_issuer: t.issuer,
        balance: t.balance ?? '0',
      })),
    ],
  };
}

function makeActiveInspection(
  overrides: Partial<OpenerLinkInspection> = {},
): OpenerLinkInspection {
  return {
    balanceId: 'cb_1284_test',
    state: 'active',
    amount: '15',
    assetCode: 'USDC',
    assetIssuer: USDC_TESTNET_ISSUER,
    sponsor: mockSender.publicKey(),
    claimantAddresses: [mockEphemeral.publicKey()],
    expiresAt: 1_900_000_000,
    expiryLabel: 'Claim within 7d',
    message: 'Ready to claim.',
    ...overrides,
  };
}

describe('claimFlow — stacked #1284 onboarding, reserves, checkpoints, and real-hash resume', () => {
  const originalSponsorEnv = process.env.EXPO_PUBLIC_SPONSOR_CLAIM_URL;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSecureMap.clear();
    resetClaimFlowMemoryForTests();
    clearClaimLinkSecret();
    await AsyncStorage.clear();
    delete process.env.EXPO_PUBLIC_SPONSOR_CLAIM_URL;
    await setNetwork('testnet');

    mockHasUsableWallet.mockResolvedValue(false);
    mockRequireSigner.mockResolvedValue({
      publicKey: mockRecipient.publicKey(),
      sign: jest.fn(),
    });
    mockFundWithFriendbot.mockResolvedValue(true);
    mockInspectClaimLink.mockResolvedValue(makeActiveInspection());
  });

  afterEach(() => {
    if (originalSponsorEnv === undefined) {
      delete process.env.EXPO_PUBLIC_SPONSOR_CLAIM_URL;
    } else {
      process.env.EXPO_PUBLIC_SPONSOR_CLAIM_URL = originalSponsorEnv;
    }
  });

  describe('Stellar reserve math and sponsor gating', () => {
    it('computes exact peak reserves matching 3.5 XLM cap and rejects underfunded 2.0 XLM accounts', async () => {
      expect(MAX_SPONSORED_CLAIM_XLM_PER_WALLET).toBe('3.5');
      expect(requiredClaimFeePayerXlm({ isIssuedAsset: false, usesEphemeralClaimant: false })).toBe(1.1);
      expect(requiredClaimFeePayerXlm({ isIssuedAsset: true, usesEphemeralClaimant: false })).toBe(1.6);
      expect(requiredClaimFeePayerXlm({ isIssuedAsset: false, usesEphemeralClaimant: true })).toBe(2.1);
      expect(requiredClaimFeePayerXlm({ isIssuedAsset: true, usesEphemeralClaimant: true })).toBe(3.1);
      expect(
        requiredClaimFeePayerXlm({
          isIssuedAsset: true,
          recipientHasTrustline: true,
          usesEphemeralClaimant: true,
        }),
      ).toBe(2.6);

      // Mainnet account with 2.0 XLM must be rejected for both ephemeral XLM (2.1) and USDC (3.1).
      await setNetwork('mainnet');
      mockLoadAccount.mockImplementation(async (addr: string) => {
        if (addr === mockRecipient.publicKey()) return makeAccount('2.0000000');
        throw notFoundError();
      });

      const xlmUnderfunded = await ensureClaimFeePayerFunded({
        feePayerAddress: mockRecipient.publicKey(),
        balanceId: 'cb_xlm',
        isIssuedAsset: false,
        ephemeralPublicKey: mockEphemeral.publicKey(),
      });
      expect(xlmUnderfunded.funded).toBe(false);
      expect(xlmUnderfunded.requiredXlm).toBe('2.10');

      const usdcUnderfunded = await ensureClaimFeePayerFunded({
        feePayerAddress: mockRecipient.publicKey(),
        balanceId: 'cb_usdc',
        isIssuedAsset: true,
        assetCode: 'USDC',
        assetIssuer: USDC_TESTNET_ISSUER,
        ephemeralPublicKey: mockEphemeral.publicKey(),
      });
      expect(usdcUnderfunded.funded).toBe(false);
      expect(usdcUnderfunded.requiredXlm).toBe('3.10');

      // 2.1 XLM passes ephemeral XLM; 3.1 XLM passes ephemeral USDC.
      mockLoadAccount.mockImplementation(async (addr: string) => {
        if (addr === mockRecipient.publicKey()) return makeAccount('2.1000000');
        throw notFoundError();
      });
      const xlmEnough = await ensureClaimFeePayerFunded({
        feePayerAddress: mockRecipient.publicKey(),
        balanceId: 'cb_xlm',
        isIssuedAsset: false,
        ephemeralPublicKey: mockEphemeral.publicKey(),
      });
      expect(xlmEnough.funded).toBe(true);

      mockLoadAccount.mockImplementation(async (addr: string) => {
        if (addr === mockRecipient.publicKey()) return makeAccount('3.1000000');
        throw notFoundError();
      });
      const usdcEnough = await ensureClaimFeePayerFunded({
        feePayerAddress: mockRecipient.publicKey(),
        balanceId: 'cb_usdc',
        isIssuedAsset: true,
        assetCode: 'USDC',
        assetIssuer: USDC_TESTNET_ISSUER,
        ephemeralPublicKey: mockEphemeral.publicKey(),
      });
      expect(usdcEnough.funded).toBe(true);
    });

    it('never defaults to an unshipped sponsor route and stops before passkey creation on mainnet', async () => {
      await setNetwork('mainnet');
      expect(getClaimSponsorEndpoint('mainnet')).toBeNull();
      expect(isClaimSponsorshipAvailable('mainnet')).toBe(false);

      process.env.EXPO_PUBLIC_SPONSOR_CLAIM_URL = 'http://insecure.example/sponsor';
      expect(getClaimSponsorEndpoint('mainnet')).toBeNull();

      delete process.env.EXPO_PUBLIC_SPONSOR_CLAIM_URL;
      const res = await createWalletAndClaim({
        wallet: { register: jest.fn() },
        balanceId: 'cb_mainnet_1',
        ephemeralSecret: mockEphemeral.secret(),
        linkNetwork: 'mainnet',
        inspection: makeActiveInspection(),
      });

      expect(res.status).toBe('funding_required');
      if (res.status === 'funding_required') {
        expect(res.reason).toBe(CLAIM_MAINNET_SPONSOR_UNAVAILABLE_MESSAGE);
        expect(res.feePayerAddress).toBeNull();
      }
      expect(mockCreatePasskeyWallet).not.toHaveBeenCalled();
      expect(await loadPendingClaimCheckpoint()).toBeNull();
    });
  });

  describe('SecureStore-only checkpoints without secret in URL or AsyncStorage fallback', () => {
    it('omits #s= from getPendingClaimResumeRoute, enforces 24h TTL, and never falls back to AsyncStorage', async () => {
      const saved = await savePendingClaimCheckpoint({
        balanceId: 'cb_secret_check',
        network: 'testnet',
        note: 'Coffee',
        ephemeralSecret: mockEphemeral.secret(),
        stage: 'after_creation',
        userInitiated: true,
        updatedAt: 1_000_000,
      });
      expect(saved).toBe(true);

      const route = await getPendingClaimResumeRoute(1_000_500);
      expect(route).toBe('/claim?id=cb_secret_check&network=testnet&note=Coffee');
      expect(route).not.toContain('s=');
      expect(route).not.toContain(mockEphemeral.secret());

      // Expired (> 24h) auto-clears and returns null.
      expect(await getPendingClaimResumeRoute(1_000_000 + PENDING_CLAIM_TTL_MS + 1)).toBeNull();
      expect(await loadPendingClaimCheckpoint(1_000_000 + PENDING_CLAIM_TTL_MS + 1)).toBeNull();

      // SecureStore failure must fail closed with zero AsyncStorage fallback.
      const asyncSetSpy = jest.spyOn(AsyncStorage, 'setItem');
      asyncSetSpy.mockClear();
      (SecureStore.setItemAsync as jest.Mock).mockRejectedValueOnce(new Error('Keychain locked'));
      const failedSave = await savePendingClaimCheckpoint({
        balanceId: 'cb_fail_closed',
        ephemeralSecret: mockEphemeral.secret(),
        stage: 'before_passkey',
        userInitiated: true,
      });
      expect(failedSave).toBe(false);
      expect(asyncSetSpy).not.toHaveBeenCalled();
      asyncSetSpy.mockRestore();
    });

    it('dismissPendingClaim wipes both in-memory deep-link secret and SecureStore checkpoint', async () => {
      resolveDeepLink(
        `https://app.useveilapp.xyz/claim/cb_dismiss?network=testnet#s=${mockEphemeral.secret()}`,
      );
      await savePendingClaimCheckpoint({
        balanceId: 'cb_dismiss',
        ephemeralSecret: mockEphemeral.secret(),
        stage: 'before_passkey',
        userInitiated: true,
      });

      expect(peekClaimLinkSecret('cb_dismiss')).toBe(mockEphemeral.secret());
      expect(await loadPendingClaimCheckpoint()).not.toBeNull();

      await dismissPendingClaim('cb_dismiss');

      expect(peekClaimLinkSecret('cb_dismiss')).toBeNull();
      expect(await loadPendingClaimCheckpoint()).toBeNull();
    });
  });

  describe('Canonical onboarding reuse, strict PRF refusal, and delegation to #1356 claimLinkWithSpendingAccount', () => {
    it('creates passkey wallet, verifies funding, and delegates claim to claimLinkWithSpendingAccount', async () => {
      const realTxHash = '1'.repeat(64);
      const mergeTxHash = '2'.repeat(64);
      mockCreatePasskeyWallet.mockResolvedValue({
        status: 'created',
        wallet: { address: 'CNEWWALLET123', funded: true, recoverable: true },
      });
      mockLoadAccount.mockImplementation(async (addr: string) => {
        if (addr === mockRecipient.publicKey()) return makeAccount('10000.0000000');
        throw notFoundError();
      });
      mockClaimLinkWithSpending.mockResolvedValue({
        status: 'claimed',
        txHash: realTxHash,
        mergeTxHash,
        reserveReleased: true,
        reserveReleaseTxHash: mergeTxHash,
        amount: '15',
        assetCode: 'USDC',
        assetIssuer: USDC_TESTNET_ISSUER,
      });

      const res = await createWalletAndClaim({
        wallet: { register: jest.fn() },
        balanceId: 'cb_1284_test',
        ephemeralSecret: mockEphemeral.secret(),
        linkNetwork: 'testnet',
        inspection: makeActiveInspection(),
      });

      expect(mockCreatePasskeyWallet).toHaveBeenCalledTimes(1);
      expect(mockClaimLinkWithSpending).toHaveBeenCalledWith(
        expect.objectContaining({
          balanceId: 'cb_1284_test',
          ephemeralSecret: mockEphemeral.secret(),
          linkNetwork: 'testnet',
        }),
      );
      expect(res).toEqual({
        status: 'claimed',
        txHash: realTxHash,
        reserveReleased: true,
        reserveReleaseTxHash: mergeTxHash,
        reserveReleaseError: undefined,
        amount: '15',
        assetCode: 'USDC',
        assetIssuer: USDC_TESTNET_ISSUER,
        createdNewWallet: true,
      });
      expect(await loadPendingClaimCheckpoint()).toBeNull();
    });

    it('refuses random fee-payer commit when PRF is unsupported and allows retryPendingPrfAndClaim without re-registering', async () => {
      const commitMock = jest.fn(async (_feePayer?: Keypair | null) => ({
        address: 'CPENDINGWALLET',
        funded: true,
        recoverable: true,
      }));
      const pendingWallet: PendingPrfWallet = {
        status: 'unsupported',
        walletAddress: 'CPENDINGWALLET',
        keyId: 'cred-123',
        issue: 'cancelled',
        commit: commitMock,
      };
      mockCreatePasskeyWallet.mockResolvedValue(pendingWallet);

      const refused = await createWalletAndClaim({
        wallet: { register: jest.fn() },
        balanceId: 'cb_prf_1',
        ephemeralSecret: mockEphemeral.secret(),
        linkNetwork: 'testnet',
        inspection: makeActiveInspection(),
      });

      expect(refused.status).toBe('prf_refused');
      expect(commitMock).not.toHaveBeenCalled();
      expect(mockClaimLinkWithSpending).not.toHaveBeenCalled();
      const cp = await loadPendingClaimCheckpoint();
      expect(cp?.stage).toBe('after_passkey');

      // Retry PRF on the same credential succeeds -> commits PRF keypair and claims.
      const prfSeed = new Uint8Array(32).fill(7);
      mockEvaluatePrf.mockResolvedValue({ outcome: 'ok', output: prfSeed });
      mockLoadAccount.mockImplementation(async (addr: string) => {
        if (addr === mockRecipient.publicKey()) return makeAccount('10000.0000000');
        throw notFoundError();
      });
      const realTxHash = '3'.repeat(64);
      mockClaimLinkWithSpending.mockResolvedValue({
        status: 'claimed',
        txHash: realTxHash,
        reserveReleased: true,
        reserveReleaseTxHash: '4'.repeat(64),
        amount: '15',
        assetCode: 'USDC',
        assetIssuer: USDC_TESTNET_ISSUER,
      });

      const retried = await retryPendingPrfAndClaim({
        pendingWallet,
        balanceId: 'cb_prf_1',
        ephemeralSecret: mockEphemeral.secret(),
        linkNetwork: 'testnet',
        inspection: makeActiveInspection(),
      });

      expect(mockCreatePasskeyWallet).toHaveBeenCalledTimes(1); // never re-registered!
      expect(commitMock).toHaveBeenCalledTimes(1);
      expect(commitMock.mock.calls[0][0]).toBeInstanceOf(Keypair);
      expect(retried.status).toBe('claimed');
      if (retried.status === 'claimed') {
        expect(retried.txHash).toBe(realTxHash);
      }
    });

    it('reuses loginWithPasskey() for returning users without creating a second wallet', async () => {
      mockLoginWithPasskey.mockResolvedValue({
        address: 'CRECOVEREDWALLET',
        source: 'recovered',
      });
      mockLoadAccount.mockImplementation(async (addr: string) => {
        if (addr === mockRecipient.publicKey()) return makeAccount('50.0000000');
        throw notFoundError();
      });
      const realTxHash = '5'.repeat(64);
      mockClaimLinkWithSpending.mockResolvedValue({
        status: 'claimed',
        txHash: realTxHash,
        reserveReleased: true,
        amount: '10',
        assetCode: 'XLM',
        assetIssuer: null,
      });

      const res = await signInAndClaim({
        balanceId: 'cb_returning_1',
        ephemeralSecret: mockEphemeral.secret(),
        linkNetwork: 'testnet',
        inspection: makeActiveInspection({ assetCode: 'XLM', assetIssuer: null, amount: '10' }),
      });

      expect(mockLoginWithPasskey).toHaveBeenCalledTimes(1);
      expect(mockCreatePasskeyWallet).not.toHaveBeenCalled();
      expect(res.status).toBe('claimed');
      if (res.status === 'claimed') {
        expect(res.txHash).toBe(realTxHash);
        expect(res.createdNewWallet).toBe(false);
      }
    });
  });

  describe('Interrupted-claim resumption resolves REAL 64-char Horizon tx hash (never "settled")', () => {
    it('recovers real 64-char Tx 1 hash from Horizon and completes Tx 2 reserve release when ephemeral account still exists', async () => {
      const realTx1Hash = 'a1b2c3d4'.repeat(8);
      const realTx2Hash = 'f9e8d7c6'.repeat(8);

      await savePendingClaimCheckpoint({
        balanceId: 'cb_resumed_tx2',
        network: 'testnet',
        amount: '7',
        assetCode: 'XLM',
        assetIssuer: null,
        ephemeralSecret: mockEphemeral.secret(),
        stage: 'during_claim',
        userInitiated: true,
        feePayerAddress: mockRecipient.publicKey(),
        createdNewWallet: true,
      });

      mockForClaimableBalanceCall.mockResolvedValue({
        records: [
          {
            type: 'claim_claimable_balance',
            claimant: mockEphemeral.publicKey(),
            source_account: mockEphemeral.publicKey(),
            transaction_hash: realTx1Hash,
          },
          {
            type: 'create_claimable_balance',
            amount: '7.0000000',
            asset: 'native',
            source_account: mockSender.publicKey(),
          },
        ],
      });
      mockTransactionCall.mockResolvedValue({
        source_account: mockRecipient.publicKey(),
      });
      // Ephemeral account still exists with 0 XLM (interrupted between Tx 1 and Tx 2).
      mockLoadAccount.mockImplementation(async (addr: string) => {
        if (addr === mockEphemeral.publicKey()) {
          return makeAccount('0.0000000');
        }
        return makeAccount('10000.0000000');
      });
      mockRetryReleaseReserve.mockResolvedValue({
        released: true,
        txHash: realTx2Hash,
      });

      const resumed = await resumeInterruptedClaimOnChain({
        balanceId: 'cb_resumed_tx2',
        ephemeralSecret: mockEphemeral.secret(),
      });

      expect(resumed).toEqual({
        status: 'claimed',
        txHash: realTx1Hash,
        reserveReleased: true,
        reserveReleaseTxHash: realTx2Hash,
        amount: '7.0000000',
        assetCode: 'XLM',
        assetIssuer: null,
        createdNewWallet: true,
        resumed: true,
      });
      expect(resumed?.status === 'claimed' && resumed.txHash).not.toBe('settled');
      expect(mockRetryReleaseReserve).toHaveBeenCalledWith(
        expect.objectContaining({ ephemeralSecret: mockEphemeral.secret() }),
      );
      expect(await loadPendingClaimCheckpoint()).toBeNull();
    });

    it('rejects claiming credit when a third party raced the same bearer link first', async () => {
      const otherTxHash = '9'.repeat(64);
      mockForClaimableBalanceCall.mockResolvedValue({
        records: [
          {
            type: 'claim_claimable_balance',
            claimant: mockEphemeral.publicKey(),
            source_account: mockEphemeral.publicKey(),
            transaction_hash: otherTxHash,
          },
        ],
      });
      // Transaction source & payment destination belong to a different account, NOT our recipient!
      mockTransactionCall.mockResolvedValue({
        source_account: mockOtherUser.publicKey(),
      });
      mockForTransactionCall.mockResolvedValue({
        records: [
          {
            type: 'payment',
            to: mockOtherUser.publicKey(),
            amount: '7.0000000',
            asset_type: 'native',
          },
        ],
      });

      const server = new Horizon.Server('https://horizon-testnet.stellar.org');
      const lookup = await resolveSettledClaimOnChain({
        server,
        balanceId: 'cb_stolen_race',
        ephemeralPublicKey: mockEphemeral.publicKey(),
        recipientPublicKey: mockRecipient.publicKey(),
      });

      expect(lookup).toEqual({ claimedByRecipient: false });
      await clearPendingClaimCheckpoint();
    });
  });
});
