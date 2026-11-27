import { Keypair } from '@stellar/stellar-sdk';

import ClaimScreen from '../app/claim';
import { USDC_TESTNET_ISSUER } from '../lib/assets';
import { clearClaimLinkSecret, peekClaimLinkSecret, resolveDeepLink } from '../lib/deepLinks';

const mockSender = Keypair.random();
const mockEphemeral = Keypair.random();
const mockRecipient = Keypair.random();
const mockInspect = jest.fn();
const mockClaimWithSpending = jest.fn();
const mockRetryReleaseReserve = jest.fn();
const mockHasUsableWallet = jest.fn(async () => true);
const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockBack = jest.fn();

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
jest.mock('react-native-safe-area-context', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return { SafeAreaView: View };
});
jest.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#000000' }) }),
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
  });
  return tree.root;
}

describe('ClaimScreen — mobile universal-link claim path (#1285)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearClaimLinkSecret();
    mockSearchParams = { id: 'cb_mobile_1', network: 'testnet', note: 'Lunch split' };
    mockHasUsableWallet.mockResolvedValue(true);
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
        root.findByProps({ testID: 'claim-retry-reserve-release' }).props.onPress as () => Promise<void>
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
  });
});
