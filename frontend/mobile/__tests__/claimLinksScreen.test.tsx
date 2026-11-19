import { Keypair } from '@stellar/stellar-sdk';

import ClaimLinksScreen from '../app/claim-links';

const mockSender = Keypair.random();
const mockFetchSummary = jest.fn();
const mockReclaimSafely = jest.fn();

jest.mock('react-native-safe-area-context', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
  };
});

jest.mock('../components/FlowHeader', () => ({ FlowHeader: () => null }));
jest.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#000000' }) }),
}));
jest.mock('../lib/activity', () => ({
  getFeePayerAddress: jest.fn(async () => mockSender.publicKey()),
}));
jest.mock('../lib/passkey', () => ({
  requirePasskey: jest.fn(async () => undefined),
}));
jest.mock('../lib/walletStore', () => ({
  getSignerSecret: jest.fn(async () => mockSender.secret()),
  getWalletAddress: jest.fn(async () => mockSender.publicKey()),
}));
jest.mock('../lib/escrow', () => {
  const actual = jest.requireActual('../lib/escrow');
  return {
    ...actual,
    fetchWalletTiedUpSummary: (...args: unknown[]) => mockFetchSummary(...args),
    reclaimEscrowSafely: (...args: unknown[]) => mockReclaimSafely(...args),
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
    tree = renderer.create(<ClaimLinksScreen />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return tree.root;
}

describe('ClaimLinksScreen (#1286)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows tied-up reserves, refuses pre-expiry reclaim, and reclaims expired links in one tap', async () => {
    mockFetchSummary.mockResolvedValue({
      walletAddress: mockSender.publicKey(),
      openLinkCount: 2,
      activeLinkCount: 1,
      expiredUnreclaimedCount: 1,
      lockedReserveXlm: '2',
      reclaimableReserveXlm: '1',
      assets: [
        {
          assetKey: 'XLM:native',
          assetCode: 'XLM',
          assetIssuer: null,
          totalAmount: '30',
          reclaimableAmount: '10',
          linkCount: 2,
        },
      ],
      links: [
        {
          balanceId: 'cb_active',
          amount: '20',
          assetCode: 'XLM',
          assetIssuer: null,
          expiresAt: 1_900_000_000,
          senderExpiryLabel: 'Expires in 6d — reclaim unlocks after expiry',
          state: 'active',
          statusLabel: 'Unclaimed',
          canReclaim: false,
          reserveLockedXlm: '1',
        },
        {
          balanceId: 'cb_expired',
          amount: '10',
          assetCode: 'XLM',
          assetIssuer: null,
          expiresAt: 1_700_000_000,
          senderExpiryLabel: 'Expired 2d ago · ready to reclaim',
          state: 'expired_unreclaimed',
          statusLabel: 'Expired and not yet reclaimed',
          canReclaim: true,
          reserveLockedXlm: '1',
        },
      ],
    });

    mockReclaimSafely.mockResolvedValue({
      status: 'reclaimed',
      txHash: 'tx_123',
      sweptReserveXlm: '1',
      sweptEphemeralAccount: false,
    });

    const root = await renderScreen();

    expect(text(root.findByProps({ testID: 'claim-links-locked-reserve' }))).toContain(
      '2 XLM reserve locked across 2 open links',
    );
    expect(text(root.findByProps({ testID: 'claim-links-asset-XLM' }))).toContain(
      '30 XLM unclaimed · 10 XLM ready to reclaim',
    );

    // Tapping an active pre-expiry link refuses without calling reclaimEscrowSafely.
    await renderer.act(async () => {
      await (
        root.findByProps({ testID: 'claim-link-reclaim-cb_active' }).props.onPress as () => Promise<void>
      )();
    });
    expect(mockReclaimSafely).not.toHaveBeenCalled();
    expect(text(root.findByProps({ testID: 'claim-links-error' }))).toContain('not expired yet');

    // Tapping the expired link reclaims principal + reserve in one action.
    await renderer.act(async () => {
      await (
        root.findByProps({ testID: 'claim-link-reclaim-cb_expired' }).props.onPress as () => Promise<void>
      )();
    });
    expect(mockReclaimSafely).toHaveBeenCalledTimes(1);
    expect(text(root.findByProps({ testID: 'claim-links-feedback' }))).toContain(
      'Reclaimed 10 XLM and freed 1 XLM of reserve.',
    );
  });
});
