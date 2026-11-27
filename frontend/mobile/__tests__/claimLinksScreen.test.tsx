import AsyncStorage from '@react-native-async-storage/async-storage';
import { Keypair } from '@stellar/stellar-sdk';

import ClaimLinksScreen from '../app/claim-links';

const mockSender = Keypair.random();
const mockSigner = {
  publicKey: mockSender.publicKey(),
  sign: jest.fn(),
};
const mockRequireSigner = jest.fn(async () => mockSigner);
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
jest.mock('../lib/signer', () => ({
  requireSigner: () => mockRequireSigner(),
}));
jest.mock('../lib/walletStore', () => ({
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
  jest.setTimeout(15_000);

  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
  });

  it('shows tied-up reserves, refuses pre-expiry reclaim, and reclaims expired links via requireSigner()', async () => {
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

    // Tapping the expired link reclaims principal + reserve using requireSigner().
    await renderer.act(async () => {
      await (
        root.findByProps({ testID: 'claim-link-reclaim-cb_expired' }).props.onPress as () => Promise<void>
      )();
    });
    expect(mockRequireSigner).toHaveBeenCalledTimes(1);
    expect(mockReclaimSafely).toHaveBeenCalledWith({
      signer: mockSigner,
      balanceId: 'cb_expired',
      expiresAt: 1_700_000_000,
      assetCode: 'XLM',
      assetIssuer: null,
    });
    expect(text(root.findByProps({ testID: 'claim-links-feedback' }))).toContain(
      'Reclaimed 10 XLM and freed 1 XLM of reserve.',
    );
  });

  it('reads created-link metadata written by Send as a link (veil_created_claim_links_v1)', async () => {
    await AsyncStorage.setItem(
      `veil_created_claim_links_v1:${mockSender.publicKey()}`,
      JSON.stringify([
        {
          balanceId: 'cb_from_send_screen',
          amount: '15',
          assetCode: 'USDC',
          assetIssuer: 'GISSUER',
          expiresAt: 1_800_000_000,
        },
      ]),
    );
    mockFetchSummary.mockResolvedValue({
      walletAddress: mockSender.publicKey(),
      openLinkCount: 0,
      activeLinkCount: 0,
      expiredUnreclaimedCount: 0,
      lockedReserveXlm: '0',
      reclaimableReserveXlm: '0',
      assets: [],
      links: [],
    });

    await renderScreen();

    expect(mockFetchSummary).toHaveBeenCalledWith(
      mockSender.publicKey(),
      expect.any(Object),
      expect.objectContaining({
        knownLinks: [
          expect.objectContaining({
            balanceId: 'cb_from_send_screen',
            amount: '15',
            assetCode: 'USDC',
          }),
        ],
      }),
    );
  });

  it('displays "Could not be checked" when history lookup fails for a consumed balance', async () => {
    mockFetchSummary.mockResolvedValue({
      walletAddress: mockSender.publicKey(),
      openLinkCount: 0,
      activeLinkCount: 0,
      expiredUnreclaimedCount: 0,
      lockedReserveXlm: '0',
      reclaimableReserveXlm: '0',
      assets: [],
      links: [
        {
          balanceId: 'cb_unknown_history',
          amount: '8',
          assetCode: 'XLM',
          assetIssuer: null,
          expiresAt: 1_700_000_000,
          senderExpiryLabel: 'Claim history could not be checked',
          state: 'status_unknown',
          statusLabel: 'Could not be checked',
          canReclaim: false,
          reserveLockedXlm: '0',
        },
      ],
    });

    const root = await renderScreen();
    expect(text(root.findByProps({ testID: 'claim-link-state-cb_unknown_history' }))).toBe(
      'Could not be checked',
    );
    expect(text(root.findByProps({ testID: 'claim-link-expiry-cb_unknown_history' }))).toContain(
      'could not be checked',
    );
  });
});
