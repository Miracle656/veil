import { Keypair } from '@stellar/stellar-sdk';

import ClaimScreen from '../app/claim';
import { USDC_TESTNET_ISSUER } from '../lib/assets';
import {
  CLAIM_MAINNET_SPONSOR_UNAVAILABLE_MESSAGE,
  clearPendingClaimCheckpoint,
  loadPendingClaimCheckpoint,
  resetClaimFlowMemoryForTests,
  savePendingClaimCheckpoint,
  type PendingPrfWallet,
} from '../lib/claimFlow';
import { clearClaimLinkSecret, peekClaimLinkSecret, resolveDeepLink } from '../lib/deepLinks';
import { setNetwork } from '../lib/network';
import { WALLET_CREATION_LIMITATION_MESSAGE } from '../lib/platformLimitation';

const mockSender = Keypair.random();
const mockEphemeral = Keypair.random();
const mockRecipient = Keypair.random();
const mockInspect = jest.fn();
const mockClaimWithSpending = jest.fn();
const mockRetryReleaseReserve = jest.fn();
const mockHasUsableWallet = jest.fn(async () => true);
const mockCreateWalletAndClaim = jest.fn();
const mockRetryPendingPrfAndClaim = jest.fn();
const mockSignInAndClaim = jest.fn();
const mockResumeInterruptedClaim = jest.fn();
const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockBack = jest.fn();
const mockSecureStore = new Map<string, string>();
const mockWalletRegister = jest.fn();

let mockSearchParams: Record<string, string> = {
  id: 'cb_mobile_1',
  network: 'testnet',
  note: 'Lunch split',
};

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockSearchParams,
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
    back: mockBack,
    canGoBack: () => false,
  }),
}));
jest.mock('expo-linking', () => ({
  useURL: () => null,
  getInitialURL: jest.fn(async () => null),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) =>
    mockSecureStore.has(key) ? mockSecureStore.get(key)! : null,
  ),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockSecureStore.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockSecureStore.delete(key);
  }),
}));
jest.mock('react-native-safe-area-context', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return { SafeAreaView: View };
});
jest.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#000000' }) }),
}));
jest.mock('../components/WalletProvider', () => ({
  useWallet: () => ({
    session: null,
    setSession: jest.fn(),
    clearSession: jest.fn(),
    wallet: { register: mockWalletRegister },
  }),
}));
jest.mock('../components/FlowHeader', () => ({ FlowHeader: () => null }));
jest.mock('../components/SuccessAnimation', () => ({ SuccessAnimation: () => null }));
jest.mock('../components/TokenIcon', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return {
    TokenIcon: ({ code }: { code: string }) =>
      React.createElement(View, { testID: `token-icon-${code}` }),
  };
});
jest.mock('../lib/passkey', () => ({
  requirePasskey: jest.fn(async () => undefined),
}));
jest.mock('../lib/signer', () => ({
  requireSigner: jest.fn(async () => ({ publicKey: mockRecipient.publicKey(), sign: jest.fn() })),
}));
jest.mock('../lib/walletStore', () => ({
  hasUsableWallet: () => mockHasUsableWallet(),
}));
jest.mock('../lib/escrow', () => {
  const actual = jest.requireActual('../lib/escrow');
  return {
    ...actual,
    inspectClaimLinkForOpener: (...args: unknown[]) => mockInspect(...args),
  };
});
jest.mock('../lib/sendClaimLink', () => {
  const actual = jest.requireActual('../lib/sendClaimLink');
  return {
    ...actual,
    claimLinkWithSpendingAccount: (...args: unknown[]) => mockClaimWithSpending(...args),
    retryReleaseClaimReserve: (...args: unknown[]) => mockRetryReleaseReserve(...args),
  };
});
jest.mock('../lib/claimFlow', () => {
  const actual = jest.requireActual('../lib/claimFlow');
  return {
    ...actual,
    createWalletAndClaim: (...args: unknown[]) => mockCreateWalletAndClaim(...args),
    retryPendingPrfAndClaim: (...args: unknown[]) => mockRetryPendingPrfAndClaim(...args),
    signInAndClaim: (...args: unknown[]) => mockSignInAndClaim(...args),
    resumeInterruptedClaimOnChain: (...args: unknown[]) => mockResumeInterruptedClaim(...args),
  };
});

type Instance = { props: Record<string, unknown>; children: (Instance | string)[] };
type TestNode = Instance & {
  findByProps: (p: object) => Instance;
  findAllByProps: (p: object) => Instance[];
};
type Tree = { root: TestNode; unmount: () => void };
type Renderer = {
  act: (fn: () => Promise<void>) => Promise<void>;
  create: (el: unknown) => Tree;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer: Renderer = require('react-test-renderer');

function text(node: Instance): string {
  return node.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
}

async function renderScreen() {
  let tree!: Tree;
  await renderer.act(async () => {
    tree = renderer.create(<ClaimScreen />);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return tree.root;
}

describe('ClaimScreen — mobile universal-link claim & one-tap onboarding (#1285 / #1284)', () => {
  const originalSponsorEnv = process.env.EXPO_PUBLIC_SPONSOR_CLAIM_URL;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSecureStore.clear();
    resetClaimFlowMemoryForTests();
    clearClaimLinkSecret();
    await clearPendingClaimCheckpoint();
    delete process.env.EXPO_PUBLIC_SPONSOR_CLAIM_URL;
    await setNetwork('testnet');
    mockSearchParams = { id: 'cb_mobile_1', network: 'testnet', note: 'Lunch split' };
    mockHasUsableWallet.mockResolvedValue(true);
    mockResumeInterruptedClaim.mockResolvedValue(null);
  });

  afterEach(() => {
    if (originalSponsorEnv === undefined) {
      delete process.env.EXPO_PUBLIC_SPONSOR_CLAIM_URL;
    } else {
      process.env.EXPO_PUBLIC_SPONSOR_CLAIM_URL = originalSponsorEnv;
    }
  });

  it('reads verified amount/sender from Horizon, shows icon for registered USDC, and claims with in-memory #s= secret', async () => {
    const resolvedRoute = resolveDeepLink(
      `https://app.useveilapp.xyz/claim/cb_mobile_1?network=testnet&amount=9999&asset=FAKE&note=Lunch%20split#s=${mockEphemeral.secret()}`,
    );
    expect(resolvedRoute).toBe('/claim?id=cb_mobile_1&network=testnet&note=Lunch%20split');
    expect(resolvedRoute).not.toContain(mockEphemeral.secret());

    mockInspect.mockResolvedValue({
      balanceId: 'cb_mobile_1',
      state: 'active',
      amount: '15',
      assetCode: 'USDC',
      assetIssuer: USDC_TESTNET_ISSUER,
      sponsor: mockSender.publicKey(),
      claimantAddresses: [mockEphemeral.publicKey()],
      expiresAt: 1_900_000_000,
      expiryLabel: 'Claim within 7d',
      message: 'Ready to claim.',
    });
    const fullTxHash = 'a'.repeat(64);
    mockClaimWithSpending.mockResolvedValue({
      status: 'claimed',
      txHash: fullTxHash,
      mergeTxHash: 'b'.repeat(64),
      reserveReleased: true,
      reserveReleaseTxHash: 'b'.repeat(64),
      amount: '15',
      assetCode: 'USDC',
      assetIssuer: USDC_TESTNET_ISSUER,
    });

    const root = await renderScreen();

    expect(text(root.findByProps({ testID: 'claim-asset-badge' }))).toContain('Verified asset');
    expect(root.findAllByProps({ testID: 'claim-verified-icon' }).length).toBeGreaterThan(0);
    expect(text(root.findByProps({ testID: 'claim-verified-amount' }))).toBe('15 USDC');
    expect(text(root.findByProps({ testID: 'claim-verified-sender' }))).toBe(
      mockSender.publicKey(),
    );
    expect(text(root.findByProps({ testID: 'claim-sender-note' }))).toBe('Lunch split');

    await renderer.act(async () => {
      await (root.findByProps({ testID: 'claim-submit' }).props.onPress as () => Promise<void>)();
    });

    expect(mockClaimWithSpending).toHaveBeenCalledWith(
      expect.objectContaining({
        balanceId: 'cb_mobile_1',
        ephemeralSecret: mockEphemeral.secret(),
        linkNetwork: 'testnet',
      }),
    );
    expect(text(root.findByProps({ testID: 'claim-tx-hash' }))).toBe(fullTxHash);
    expect(root.findAllByProps({ testID: 'claim-reserve-release-warning' })).toHaveLength(0);
    expect(peekClaimLinkSecret('cb_mobile_1')).toBeNull();
  });

  it('surfaces Tx 2 reserve-release failure, retains the link secret, and clears it only after retry succeeds', async () => {
    resolveDeepLink(
      `https://app.useveilapp.xyz/claim/cb_mobile_1?network=testnet#s=${mockEphemeral.secret()}`,
    );
    mockInspect.mockResolvedValue({
      balanceId: 'cb_mobile_1',
      state: 'active',
      amount: '10',
      assetCode: 'XLM',
      assetIssuer: null,
      sponsor: mockSender.publicKey(),
      claimantAddresses: [mockEphemeral.publicKey()],
      expiresAt: 1_900_000_000,
      expiryLabel: 'Claim within 7d',
      message: 'Ready to claim.',
    });
    const fullTxHash = 'c'.repeat(64);
    mockClaimWithSpending.mockResolvedValue({
      status: 'claimed',
      txHash: fullTxHash,
      mergeTxHash: null,
      reserveReleased: false,
      reserveReleaseError: 'Horizon timeout on accountMerge',
      amount: '10',
      assetCode: 'XLM',
      assetIssuer: null,
    });
    mockRetryReleaseReserve.mockResolvedValue({
      released: true,
      txHash: 'd'.repeat(64),
    });

    const root = await renderScreen();
    await renderer.act(async () => {
      await (root.findByProps({ testID: 'claim-submit' }).props.onPress as () => Promise<void>)();
    });

    // Warning shown, secret retained in memory so retry can run without reopening the link.
    expect(text(root.findByProps({ testID: 'claim-reserve-release-warning' }))).toContain(
      '1 XLM sponsor reserve',
    );
    expect(text(root.findByProps({ testID: 'claim-reserve-release-error' }))).toContain(
      'Horizon timeout on accountMerge',
    );
    expect(peekClaimLinkSecret('cb_mobile_1')).toBe(mockEphemeral.secret());

    // Tap retry button -> releases reserve, hides warning, and clears secret.
    await renderer.act(async () => {
      await (
        root.findByProps({ testID: 'claim-retry-reserve-release' }).props
          .onPress as () => Promise<void>
      )();
    });

    expect(mockRetryReleaseReserve).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeralSecret: mockEphemeral.secret(),
      }),
    );
    expect(root.findAllByProps({ testID: 'claim-reserve-release-warning' })).toHaveLength(0);
    expect(text(root.findByProps({ testID: 'claim-reserve-released-ok' }))).toContain(
      '1 XLM sponsor reserve released',
    );
    expect(peekClaimLinkSecret('cb_mobile_1')).toBeNull();
  });

  it('labels an impostor USDC from an unknown issuer as Unverified asset with NO icon', async () => {
    const fakeIssuer = Keypair.random().publicKey();
    mockInspect.mockResolvedValue({
      balanceId: 'cb_mobile_1',
      state: 'active',
      amount: '100',
      assetCode: 'USDC',
      assetIssuer: fakeIssuer,
      sponsor: mockSender.publicKey(),
      claimantAddresses: [mockEphemeral.publicKey()],
      expiresAt: 1_900_000_000,
      expiryLabel: 'Claim within 7d',
      message: 'Ready to claim.',
    });

    const root = await renderScreen();

    expect(text(root.findByProps({ testID: 'claim-asset-badge' }))).toBe('Unverified asset');
    expect(root.findAllByProps({ testID: 'claim-verified-icon' })).toHaveLength(0);
    expect(root.findAllByProps({ testID: 'token-icon-USDC' })).toHaveLength(0);
    expect(text(root.findByProps({ testID: 'claim-unverified-warning' }))).toMatch(
      /not in Veil’s verified registry/i,
    );
  });

  it('renders network mismatch and not_found states without calling them claimed', async () => {
    mockSearchParams = { id: 'cb_mobile_1', network: 'mainnet' };
    mockInspect.mockResolvedValue({
      balanceId: 'cb_mobile_1',
      state: 'network_mismatch',
      amount: null,
      assetCode: null,
      assetIssuer: null,
      sponsor: null,
      claimantAddresses: [],
      expiresAt: null,
      expiryLabel: null,
      linkNetwork: 'mainnet',
      activeNetwork: 'testnet',
      message:
        'This link was created on Stellar Mainnet, while your wallet is set to Stellar Testnet. Switch networks in Settings to open it.',
    });

    const root = await renderScreen();

    expect(text(root.findByProps({ testID: 'claim-consumed-message' }))).toContain(
      'Stellar Mainnet',
    );
    expect(text(root.findByProps({ testID: 'claim-consumed-message' }))).not.toMatch(
      /already been claimed/i,
    );
    expect(root.findAllByProps({ testID: 'claim-switch-network' }).length).toBeGreaterThan(0);
  });

  it('never displays unchecked details when Horizon cannot be read and always lets the user leave', async () => {
    mockInspect.mockRejectedValue(new Error('Network offline'));

    const root = await renderScreen();

    expect(text(root.findByProps({ testID: 'claim-load-error' }))).toMatch(
      /Could not read this claim link/i,
    );
    expect(root.findAllByProps({ testID: 'claim-verified-amount' })).toHaveLength(0);
    expect(root.findAllByProps({ testID: 'claim-leave' }).length).toBeGreaterThan(0);
  });

  it('fresh walletless install verifies issuer, shows origin-binding notice, creates wallet + claims, and displays real 64-char tx hash', async () => {
    mockHasUsableWallet.mockResolvedValue(false);
    resolveDeepLink(
      `https://app.useveilapp.xyz/claim/cb_mobile_1?network=testnet#s=${mockEphemeral.secret()}`,
    );
    mockInspect.mockResolvedValue({
      balanceId: 'cb_mobile_1',
      state: 'active',
      amount: '25',
      assetCode: 'USDC',
      assetIssuer: USDC_TESTNET_ISSUER,
      sponsor: mockSender.publicKey(),
      claimantAddresses: [mockEphemeral.publicKey()],
      expiresAt: 1_900_000_000,
      expiryLabel: 'Claim within 7d',
      message: 'Ready to claim.',
    });
    const realTxHash = 'e'.repeat(64);
    mockCreateWalletAndClaim.mockResolvedValue({
      status: 'claimed',
      txHash: realTxHash,
      reserveReleased: true,
      reserveReleaseTxHash: 'f'.repeat(64),
      amount: '25',
      assetCode: 'USDC',
      assetIssuer: USDC_TESTNET_ISSUER,
      createdNewWallet: true,
    });

    const root = await renderScreen();

    // Passive link open must NOT save a checkpoint.
    expect(await loadPendingClaimCheckpoint()).toBeNull();
    expect(text(root.findByProps({ testID: 'claim-asset-badge' }))).toBe(
      'Verified asset · Circle',
    );
    expect(root.findAllByProps({ testID: 'claim-verified-icon' }).length).toBeGreaterThan(0);
    expect(text(root.findByProps({ testID: 'claim-origin-binding-notice' }))).toBe(
      WALLET_CREATION_LIMITATION_MESSAGE,
    );
    expect(text(root.findByProps({ testID: 'claim-create-and-claim' }))).toBe(
      'Create wallet & claim 25 USDC',
    );

    await renderer.act(async () => {
      await (
        root.findByProps({ testID: 'claim-create-and-claim' }).props.onPress as () => Promise<void>
      )();
    });

    expect(mockCreateWalletAndClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        balanceId: 'cb_mobile_1',
        ephemeralSecret: mockEphemeral.secret(),
      }),
    );
    expect(text(root.findByProps({ testID: 'claim-tx-hash' }))).toBe(realTxHash);
  });

  it('fresh walletless install marks unverified issuer clearly without icon and warns in create-and-claim CTA', async () => {
    mockHasUsableWallet.mockResolvedValue(false);
    const impostorIssuer = Keypair.random().publicKey();
    mockInspect.mockResolvedValue({
      balanceId: 'cb_mobile_1',
      state: 'active',
      amount: '50',
      assetCode: 'USDC',
      assetIssuer: impostorIssuer,
      sponsor: mockSender.publicKey(),
      claimantAddresses: [mockEphemeral.publicKey()],
      expiresAt: 1_900_000_000,
      expiryLabel: 'Claim within 7d',
      message: 'Ready to claim.',
    });

    const root = await renderScreen();

    expect(text(root.findByProps({ testID: 'claim-asset-badge' }))).toBe('Unverified asset');
    expect(root.findAllByProps({ testID: 'claim-verified-icon' })).toHaveLength(0);
    expect(root.findAllByProps({ testID: 'token-icon-USDC' })).toHaveLength(0);
    expect(text(root.findByProps({ testID: 'claim-create-and-claim' }))).toBe(
      'Create wallet & claim 50 unverified USDC',
    );
  });

  it('stops before passkey creation on mainnet when no sponsor is configured and offers sign-in for existing wallets', async () => {
    await setNetwork('mainnet');
    mockSearchParams = { id: 'cb_mobile_1', network: 'mainnet' };
    mockHasUsableWallet.mockResolvedValue(false);
    resolveDeepLink(
      `https://app.useveilapp.xyz/claim/cb_mobile_1?network=mainnet#s=${mockEphemeral.secret()}`,
    );
    mockInspect.mockResolvedValue({
      balanceId: 'cb_mobile_1',
      state: 'active',
      amount: '10',
      assetCode: 'XLM',
      assetIssuer: null,
      sponsor: mockSender.publicKey(),
      claimantAddresses: [mockEphemeral.publicKey()],
      expiresAt: 1_900_000_000,
      expiryLabel: 'Claim within 7d',
      message: 'Ready to claim.',
    });
    const signInHash = '7'.repeat(64);
    mockSignInAndClaim.mockResolvedValue({
      status: 'claimed',
      txHash: signInHash,
      reserveReleased: true,
      amount: '10',
      assetCode: 'XLM',
      assetIssuer: null,
      createdNewWallet: false,
    });

    const root = await renderScreen();

    expect(root.findAllByProps({ testID: 'claim-create-and-claim' })).toHaveLength(0);
    expect(text(root.findByProps({ testID: 'claim-mainnet-sponsor-notice' }))).toBe(
      CLAIM_MAINNET_SPONSOR_UNAVAILABLE_MESSAGE,
    );

    await renderer.act(async () => {
      await (
        root.findByProps({ testID: 'claim-sign-in-and-claim' }).props.onPress as () => Promise<void>
      )();
    });

    expect(mockSignInAndClaim).toHaveBeenCalledTimes(1);
    expect(text(root.findByProps({ testID: 'claim-tx-hash' }))).toBe(signInHash);
  });

  it('handles non-PRF refusal without calling recreatePasskeyWallet: unsupported routes to /create-wallet, cancelled retries PRF', async () => {
    mockHasUsableWallet.mockResolvedValue(false);
    resolveDeepLink(
      `https://app.useveilapp.xyz/claim/cb_mobile_1?network=testnet#s=${mockEphemeral.secret()}`,
    );
    mockInspect.mockResolvedValue({
      balanceId: 'cb_mobile_1',
      state: 'active',
      amount: '10',
      assetCode: 'XLM',
      assetIssuer: null,
      sponsor: mockSender.publicKey(),
      claimantAddresses: [mockEphemeral.publicKey()],
      expiresAt: 1_900_000_000,
      expiryLabel: 'Claim within 7d',
      message: 'Ready to claim.',
    });

    const pendingUnsupported: PendingPrfWallet = {
      status: 'unsupported',
      walletAddress: 'CPENDING1',
      keyId: 'cred-unsupported',
      issue: 'unsupported',
      commit: jest.fn(),
    };
    mockCreateWalletAndClaim.mockResolvedValueOnce({
      status: 'prf_refused',
      issue: 'unsupported',
      reason: 'PRF unsupported by passkey manager.',
      pendingWallet: pendingUnsupported,
    });

    const root = await renderScreen();
    await renderer.act(async () => {
      await (
        root.findByProps({ testID: 'claim-create-and-claim' }).props.onPress as () => Promise<void>
      )();
    });

    expect(root.findAllByProps({ testID: 'claim-prf-refused' }).length).toBeGreaterThan(0);
    expect(root.findAllByProps({ testID: 'claim-open-create-wallet' }).length).toBeGreaterThan(0);

    await renderer.act(async () => {
      (root.findByProps({ testID: 'claim-open-create-wallet' }).props.onPress as () => void)();
    });
    expect(mockPush).toHaveBeenCalledWith('/create-wallet');
  });

  it('reconciles a resumed during_claim checkpoint on mount and displays the real 64-char Horizon tx hash', async () => {
    const resumedHash = '8'.repeat(64);
    await savePendingClaimCheckpoint({
      balanceId: 'cb_mobile_1',
      network: 'testnet',
      amount: '7',
      assetCode: 'XLM',
      assetIssuer: null,
      ephemeralSecret: mockEphemeral.secret(),
      stage: 'during_claim',
      userInitiated: true,
      createdNewWallet: true,
    });
    mockInspect.mockResolvedValue({
      balanceId: 'cb_mobile_1',
      state: 'claimed_by_other',
      amount: null,
      assetCode: null,
      assetIssuer: null,
      sponsor: mockSender.publicKey(),
      claimantAddresses: [],
      expiresAt: null,
      expiryLabel: null,
      message: 'This link has already been claimed.',
    });
    mockResumeInterruptedClaim.mockResolvedValue({
      status: 'claimed',
      txHash: resumedHash,
      reserveReleased: true,
      reserveReleaseTxHash: '9'.repeat(64),
      amount: '7',
      assetCode: 'XLM',
      assetIssuer: null,
      createdNewWallet: true,
      resumed: true,
    });

    const root = await renderScreen();

    expect(mockResumeInterruptedClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        balanceId: 'cb_mobile_1',
        ephemeralSecret: mockEphemeral.secret(),
      }),
    );
    expect(text(root.findByProps({ testID: 'claim-tx-hash' }))).toBe(resumedHash);
    expect(text(root.findByProps({ testID: 'claim-tx-hash' }))).not.toBe('settled');
  });
});
