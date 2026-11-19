import { Keypair } from '@stellar/stellar-sdk';

import SendScreen from '../app/send';
import { BEARER_LINK_WARNING } from '../lib/sendClaimLink';

const mockSender = Keypair.random();
const mockCreateLink = jest.fn();
const mockLoadLinks = jest.fn();

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ mode: 'link', amount: '10' }),
}));
jest.mock('react-native-safe-area-context', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return { SafeAreaView: View };
});
jest.mock('react-native-qrcode-svg', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: ({ value }: { value: string }) => React.createElement(View, { testID: 'mock-qr', value }),
  };
});
jest.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#000000' }), isDark: true }),
}));
jest.mock('../hooks/useCurrency', () => ({ useCurrency: () => ({ format: (n: number) => String(n) }) }));
jest.mock('../hooks/useHiddenAmounts', () => ({ useHiddenAmounts: () => ({ mask: (s: string) => s }) }));
jest.mock('../components/WalletProvider', () => ({
  useWallet: () => ({ wallet: { deploy: jest.fn() } }),
}));
jest.mock('../components/FlowHeader', () => ({ FlowHeader: () => null }));
jest.mock('../components/ContactPicker', () => ({ ContactPicker: () => null }));
jest.mock('../components/QrScanner', () => ({ QrScanner: () => null }));
jest.mock('../components/TokenIcon', () => ({ TokenIcon: () => null }));
jest.mock('../components/SuccessAnimation', () => ({ SuccessAnimation: () => null }));
jest.mock('../components/SlideToConfirm', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pressable, Text } = require('react-native');
  return {
    SlideToConfirm: ({ label, onConfirm, testID }: { label: string; onConfirm: () => void; testID?: string }) =>
      React.createElement(
        Pressable,
        { testID: testID ?? 'slide-to-confirm', onPress: onConfirm },
        React.createElement(Text, null, label),
      ),
  };
});
jest.mock('../lib/passkey', () => ({
  requirePasskey: jest.fn(async () => undefined),
}));
jest.mock('../lib/signer', () => ({
  requireSigner: jest.fn(async () => ({ publicKey: mockSender.publicKey(), sign: jest.fn() })),
}));
jest.mock('../lib/walletStore', () => ({
  getWalletAddress: jest.fn(async () => mockSender.publicKey()),
}));
jest.mock('../lib/holdings', () => ({
  loadHoldings: jest.fn(async () => [
    { code: 'XLM', name: 'Stellar Lumens', issuer: null, native: true, balance: '50' },
  ]),
  unitPrice: () => null,
}));
jest.mock('../lib/activity', () => ({
  fetchContractAssetBalance: jest.fn(async () => 0),
  getFeePayerAddress: jest.fn(async () => mockSender.publicKey()),
}));
jest.mock('../lib/contractSpend', () => ({
  getFeePayerSpendableXlm: jest.fn(async () => 48),
  getFeePayerXlm: jest.fn(async () => ({ balance: 50, subentries: 2, reserve: 2, spendable: 47.95 })),
  sendAssetFromContract: jest.fn(),
}));
jest.mock('../lib/deployWallet', () => ({ deployWalletIfNeeded: jest.fn(async () => undefined) }));
jest.mock('../lib/sendClaimLink', () => {
  const actual = jest.requireActual('../lib/sendClaimLink');
  return {
    ...actual,
    createSenderClaimLink: (...args: unknown[]) => mockCreateLink(...args),
    loadSenderClaimLinksOnChain: (...args: unknown[]) => mockLoadLinks(...args),
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
    tree = renderer.create(<SendScreen />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return tree.root;
}

describe('SendScreen — Send as a link (#1285)', () => {
  jest.setTimeout(15_000);

  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadLinks.mockResolvedValue([
      {
        balanceId: 'cb_existing_1',
        claimUrl: 'https://app.useveilapp.xyz/claim/cb_existing_1',
        amount: '5',
        assetCode: 'XLM',
        assetIssuer: null,
        expiresAt: 1_900_000_000,
        createdAt: 1_899_900_000,
        note: 'Lunch',
        status: 'unclaimed',
        canReclaim: false,
        reserveHeldXlm: '1',
      },
    ]);
  });

  it('shows the full cost breakdown, refuses URLs in notes, and renders bearer warning + QR on share', async () => {
    mockCreateLink.mockResolvedValue({
      balanceId: 'cb_new_99',
      claimUrl: 'https://app.useveilapp.xyz/claim/cb_new_99?amount=10&asset=XLM#s=SSECRET',
      amount: '10',
      assetCode: 'XLM',
      assetIssuer: null,
      expiresAt: 1_900_000_000,
      createdAt: 1_899_900_000,
      note: 'Dinner split',
      txHash: 'tx_link_99',
      cost: {
        amount: '10',
        assetCode: 'XLM',
        reserveXlm: '1',
        feeXlm: '0.0001',
        totalXlmRequired: '11.0001',
      },
    });

    const root = await renderScreen();

    // Full cost + bearer notice visible BEFORE confirmation.
    expect(text(root.findByProps({ testID: 'send-link-cost-amount' }))).toBe('10 XLM');
    expect(text(root.findByProps({ testID: 'send-link-cost-reserve' }))).toContain('1 XLM');
    expect(text(root.findByProps({ testID: 'send-link-preconfirm-bearer' }))).toBe(
      BEARER_LINK_WARNING,
    );
    expect(text(root.findByProps({ testID: 'send-created-link-status-cb_existing_1' }))).toBe(
      'Unclaimed',
    );

    // Entering a URL in the note field blocks submission and explains why.
    await renderer.act(async () => {
      (root.findByProps({ testID: 'send-link-note' }).props.onChangeText as (v: string) => void)(
        'Claim at https://evil.example',
      );
    });
    expect(text(root.findByProps({ testID: 'send-link-note-error' }))).toMatch(/cannot include links/i);

    // Replace with a safe plain-text note and confirm.
    await renderer.act(async () => {
      (root.findByProps({ testID: 'send-link-note' }).props.onChangeText as (v: string) => void)(
        'Dinner split',
      );
    });

    const submit = root
      .findAllByProps({ testID: 'send-submit' })
      .find((n) => typeof n.props.onPress === 'function');
    expect(submit).toBeDefined();

    await renderer.act(async () => {
      await Promise.all([
        (submit!.props.onPress as () => Promise<void>)(),
        (submit!.props.onPress as () => Promise<void>)(),
      ]);
    });

    // Double-tap triggers only one creation call.
    expect(mockCreateLink).toHaveBeenCalledTimes(1);

    // Share screen displays the explicit bearer warning, QR code, and Share button.
    expect(text(root.findByProps({ testID: 'send-link-bearer-warning' }))).toBe(
      'Anyone with this link can claim it.',
    );
    expect(root.findAllByProps({ testID: 'send-link-qr' }).length).toBeGreaterThan(0);
    expect(root.findAllByProps({ testID: 'send-link-share' }).length).toBeGreaterThan(0);
  });
});
