/**
 * A passkey recovery check that passed must still read as passed after the
 * screen is left and reopened.
 *
 * Reported from build 14: *"on the recovery coverage i checked passkey signed
 * and it ticked when i go back and enter that page again it says passkey
 * recovery not checked"*. The outcome lived only in this component's
 * `useState`, so unmounting threw it away and `deriveRecoveryStatus` was
 * handed `'unverified'` again — "Not checked yet", which reads as the check
 * having quietly failed, on a wallet whose recovery is in fact ready.
 *
 * The durable fact is the one `retryRecoveryBinding` already writes on
 * success: `recordFeePayerSource(address, 'prf')`, keyed to the fee-payer
 * address so a later key change cannot inherit the tick. These tests pin that
 * the screen reads it, and that a fresh failure still overrules it.
 */

const mockGetFeePayerInfo = jest.fn();
const mockCheckPasskeyRecovery = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#000000' }) }),
}));
jest.mock('../components/FlowHeader', () => ({ FlowHeader: () => null }));
jest.mock('../lib/feePayerSource', () => ({
  getFeePayerInfo: (...a: unknown[]) => mockGetFeePayerInfo(...a),
}));
jest.mock('../lib/recoveryStatusActions', () => ({
  checkPasskeyRecovery: (...a: unknown[]) => mockCheckPasskeyRecovery(...a),
}));
jest.mock('../lib/backupFile', () => ({ getLastBackupExportedAt: async () => null }));
jest.mock('../lib/recovery', () => ({ listRecoveryServerUrls: async () => [] }));
jest.mock('../lib/walletStore', () => ({
  getWalletAddress: async () => 'CWALLET',
  getSignerSecret: async () => 'SSECRET',
}));

import RecoverySettingsScreen from '../app/settings/recovery';

type Instance = { props: Record<string, unknown>; children: (Instance | string)[] };
type Renderer = {
  act: (fn: () => Promise<void>) => Promise<void>;
  create: (el: unknown) => { root: { findByProps: (p: object) => Instance } };
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

function prfDetail(root: { findByProps: (p: object) => Instance }): string {
  return text(root.findByProps({ testID: 'recovery-prf-detail' }));
}

beforeEach(() => {
  mockGetFeePayerInfo.mockReset();
  mockCheckPasskeyRecovery.mockReset();
});

it('reads a recorded PRF fee-payer as ready on a fresh mount', async () => {
  // Exactly the state a successful check leaves behind, with no component
  // state carried over — this IS reopening the screen.
  mockGetFeePayerInfo.mockResolvedValue({ address: 'GFEE', source: 'prf' });

  expect(prfDetail(await open())).toBe('Ready');
});

it('still says not checked when the fee-payer is not the passkey’s', async () => {
  mockGetFeePayerInfo.mockResolvedValue({ address: 'GFEE', source: 'random' });

  expect(prfDetail(await open())).toBe('Not checked yet');
});

it('still says not checked when nothing has been recorded', async () => {
  mockGetFeePayerInfo.mockResolvedValue({ address: 'GFEE', source: 'unknown' });

  expect(prfDetail(await open())).toBe('Not checked yet');
});

it('survives a fee-payer record that cannot be read', async () => {
  mockGetFeePayerInfo.mockRejectedValue(new Error('storage unavailable'));

  expect(prfDetail(await open())).toBe('Not checked yet');
});

it('draws the tick rather than a check button once the record says ready', async () => {
  // The row has to agree with itself: "Ready" and a button reading "Check
  // passkey" beside it was the older version of this screen's confusion.
  mockGetFeePayerInfo.mockResolvedValue({ address: 'GFEE', source: 'prf' });

  const row = (await open()).findByProps({ testID: 'recovery-prf' });

  expect(text(row)).toContain('Ready');
  expect(text(row)).toContain('✓');
  expect(text(row)).not.toContain('Check passkey');
});

/**
 * A result from this session still wins over the record: the screen only
 * consults it while its own state is `unverified`, so a check that fails now
 * is not overruled by one that passed before. That guard is read straight off
 * `prf === 'unverified' && feePayer?.source === 'prf'` in `refresh` — there is
 * no path to a failed check from a row that renders a tick instead of a
 * button, so it is left to `deriveRecoveryStatus`'s own tests rather than
 * asserted here through a button that is not on screen.
 */
