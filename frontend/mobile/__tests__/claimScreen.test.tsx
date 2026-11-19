import ClaimScreen from '../app/claim';
import { CLAIM_ALREADY_CLAIMED_MESSAGE, CLAIM_PRF_UNSUPPORTED_MESSAGE } from '../lib/claimFlow';

const mockRegister = jest.fn();
const mockReplace = jest.fn();
const mockInspect = jest.fn();
const mockExecuteClaim = jest.fn();

const mockBalanceId = `00000000${'e'.repeat(64)}`;

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({
    id: mockBalanceId,
    amount: '25',
    asset: 'USDC',
    sender: 'Tunde',
    note: 'Dinner in Yaba',
  }),
  useRouter: () => ({ replace: mockReplace, push: jest.fn(), back: jest.fn() }),
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
jest.mock('../components/TokenIcon', () => ({ TokenIcon: () => null }));
jest.mock('../components/SuccessAnimation', () => ({ SuccessAnimation: () => null }));
jest.mock('../components/WalletProvider', () => ({
  useWallet: () => ({ wallet: { register: mockRegister } }),
}));

jest.mock('../lib/claimFlow', () => {
  const actual = jest.requireActual('../lib/claimFlow');
  return {
    ...actual,
    inspectClaimBeforePrompt: (...args: unknown[]) => mockInspect(...args),
    executeOneTapClaim: (...args: unknown[]) => mockExecuteClaim(...args),
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

describe('ClaimScreen (#1284)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows amount, asset, and sender BEFORE any passkey prompt, then completes in one tap', async () => {
    mockInspect.mockResolvedValue({
      status: 'ready',
      balanceId: mockBalanceId,
      amount: '25',
      assetCode: 'USDC',
      assetIssuer: 'GISSUER',
      senderLabel: 'Tunde',
      note: 'Dinner in Yaba',
      expiresAt: 1_900_000_000,
      hasExistingWallet: false,
      resumingStage: null,
      resumeNotice: null,
    });
    mockExecuteClaim.mockResolvedValue({
      status: 'claimed',
      txHash: 'tx_done_1',
      walletAddress: 'CWALLET123',
      feePayerAddress: 'GFEEPAYER123',
      amount: '25',
      assetCode: 'USDC',
      createdNewWallet: true,
    });

    const root = await renderScreen();

    // Preview shown with zero passkey prompts triggered on mount.
    expect(mockExecuteClaim).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
    expect(text(root.findByProps({ testID: 'claim-preview-amount' }))).toBe('25 USDC');
    expect(text(root.findByProps({ testID: 'claim-preview-sender' }))).toBe('From Tunde');
    expect(text(root.findByProps({ testID: 'claim-preview-note' }))).toBe('Dinner in Yaba');
    expect(root.findAllByProps({ testID: 'claim-origin-binding-notice' }).length).toBeGreaterThan(0);

    // Single tap runs the entire ceremony and lands on funded wallet confirmation.
    await renderer.act(async () => {
      await (root.findByProps({ testID: 'claim-one-tap-button' }).props.onPress as () => Promise<void>)();
    });

    expect(mockExecuteClaim).toHaveBeenCalledTimes(1);
    expect(text(root.findByProps({ testID: 'claim-success-amount' }))).toBe(
      '25 USDC is now in your wallet',
    );
  });

  it('surfaces explicit non-PRF refusal and plain already-claimed states', async () => {
    mockInspect.mockResolvedValueOnce({
      status: 'ready',
      balanceId: mockBalanceId,
      amount: '25',
      assetCode: 'USDC',
      assetIssuer: null,
      senderLabel: 'Tunde',
      note: null,
      expiresAt: null,
      hasExistingWallet: false,
      resumingStage: null,
      resumeNotice: null,
    });
    mockExecuteClaim.mockResolvedValueOnce({
      status: 'prf_unsupported',
      message: CLAIM_PRF_UNSUPPORTED_MESSAGE,
    });

    const root = await renderScreen();
    await renderer.act(async () => {
      await (root.findByProps({ testID: 'claim-one-tap-button' }).props.onPress as () => Promise<void>)();
    });
    expect(text(root.findByProps({ testID: 'claim-prf-refused' }))).toContain(
      'does not support WebAuthn PRF',
    );

    mockInspect.mockResolvedValueOnce({
      status: 'already_claimed',
      balanceId: mockBalanceId,
      message: CLAIM_ALREADY_CLAIMED_MESSAGE,
    });
    const claimedRoot = await renderScreen();
    expect(text(claimedRoot.findByProps({ testID: 'claim-already-claimed' }))).toContain(
      CLAIM_ALREADY_CLAIMED_MESSAGE,
    );
  });
});
