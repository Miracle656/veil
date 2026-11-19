import { Keypair } from '@stellar/stellar-sdk';
import * as Clipboard from 'expo-clipboard';

const mockPush = jest.fn();
const mockSetStringAsync = jest.fn(async (_val?: string) => true);
const mockGetFeePayerInfo = jest.fn();
const mockCheckPasskeyRecoveryDetails = jest.fn();

const mockSpendingKeypair = Keypair.random();
const mockSpendingSecret = mockSpendingKeypair.secret();
const mockSpendingAddress = mockSpendingKeypair.publicKey();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
}));
jest.mock('expo-clipboard', () => ({
  setStringAsync: (val: string) => mockSetStringAsync(val),
}));
jest.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#000000' }) }),
}));
jest.mock('../components/FlowHeader', () => ({ FlowHeader: () => null }));
jest.mock('../lib/feePayerSource', () => ({
  getFeePayerInfo: (...a: unknown[]) => mockGetFeePayerInfo(...a),
}));
jest.mock('../lib/recoveryStatusActions', () => ({
  checkPasskeyRecoveryDetails: (...a: unknown[]) => mockCheckPasskeyRecoveryDetails(...a),
  checkPasskeyRecovery: (...a: unknown[]) => mockCheckPasskeyRecoveryDetails(...a),
}));
jest.mock('../lib/backupFile', () => ({ getLastBackupExportedAt: async () => null }));
jest.mock('../lib/recovery', () => ({ listRecoveryServerUrls: async () => [] }));
jest.mock('../lib/walletStore', () => ({
  getWalletAddress: async () => 'CWALLETADDRESS1234567890',
  getSignerSecret: async () => mockSpendingSecret,
}));

import RecoverySettingsScreen from '../app/settings/recovery';

type Instance = { props: Record<string, any>; children: (Instance | string)[] };
type Renderer = {
  act: (fn: () => Promise<void>) => Promise<void>;
  create: (el: unknown) => { root: { findByProps: (p: object) => Instance; findAllByProps: (p: object) => Instance[] } };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer: Renderer = require('react-test-renderer');

function text(node: Instance): string {
  return node.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
}

jest.setTimeout(60_000);

async function open() {
  let tree!: ReturnType<Renderer['create']>;
  await renderer.act(async () => {
    tree = renderer.create(<RecoverySettingsScreen />);
  });
  return tree.root;
}

describe('RecoverySettingsScreen — move refusal and shortfall handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockGetFeePayerInfo.mockResolvedValue({ address: mockSpendingAddress, source: 'random' });
  });

  afterEach(async () => {
    await renderer.act(async () => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  it('handles destination-reserve by displaying shortfall XLM, copyable spending address, and routing to save spending key', async () => {
    mockCheckPasskeyRecoveryDetails.mockResolvedValue({
      state: 'destination-reserve',
      shortfallXlm: 2,
    });

    const root = await open();

    // Trigger passkey check
    const checkBtn = root.findByProps({ testID: 'recovery-prf-check' });
    await renderer.act(async () => {
      checkBtn.props.onPress();
    });

    // 1. Shows the shortfall in XLM and the plain explanation
    const detail = text(root.findByProps({ testID: 'recovery-prf-detail' }));
    expect(detail).toContain('Veil could not move your spending account to one your passkey can restore, so nothing was changed and your money is where it was.');
    expect(detail).toContain('Your spending account needs about 2 more XLM before it can be moved. Send it to your spending address, then press the check again.');
    expect(detail).not.toMatch(/try again later/i);

    // 2. Card action button says "Save spending key"
    const actionBtn = root.findByProps({ testID: 'recovery-prf-action' });
    expect(text(actionBtn)).toBe('Save spending key');

    // 3. Pressing the failed card button routes to /settings/reveal-secret?subject=spending
    await renderer.act(async () => {
      actionBtn.props.onPress();
    });
    expect(mockPush).toHaveBeenCalledWith('/settings/reveal-secret?subject=spending');

    // 4. Dedicated top-up card is shown with spending address
    const topUpCard = root.findByProps({ testID: 'recovery-topup-card' });
    expect(text(topUpCard)).toContain('Send about 2 more XLM to this spending address');

    const addressNode = root.findByProps({ testID: 'recovery-spending-address' });
    expect(text(addressNode)).toBe(mockSpendingAddress);

    // 5. Copy button copies the FULL, unshortened address
    const copyBtn = root.findByProps({ testID: 'recovery-copy-address' });
    await renderer.act(async () => {
      copyBtn.props.onPress();
      jest.advanceTimersByTime(2000);
    });
    expect(mockSetStringAsync).toHaveBeenCalledWith(mockSpendingAddress);
    expect(mockSetStringAsync).not.toHaveBeenCalledWith(mockSpendingSecret);

    // 6. Verify that secret key is NEVER shown anywhere on the screen
    const allText = text(root as unknown as Instance);
    expect(allText).not.toContain(mockSpendingSecret);
  });

  it('routes to save-spending-key for other refusal reasons like pool-shares', async () => {
    mockCheckPasskeyRecoveryDetails.mockResolvedValue({
      state: 'pool-shares',
    });

    const root = await open();

    const checkBtn = root.findByProps({ testID: 'recovery-prf-check' });
    await renderer.act(async () => {
      checkBtn.props.onPress();
    });

    const detail = text(root.findByProps({ testID: 'recovery-prf-detail' }));
    expect(detail).toContain('It holds liquidity pool shares, which cannot be moved automatically. Withdraw your pool shares, then press the check again.');
    expect(detail).not.toMatch(/try again later/i);

    const actionBtn = root.findByProps({ testID: 'recovery-prf-action' });
    expect(text(actionBtn)).toBe('Save spending key');

    await renderer.act(async () => {
      actionBtn.props.onPress();
    });
    expect(mockPush).toHaveBeenCalledWith('/settings/reveal-secret?subject=spending');
  });
});
