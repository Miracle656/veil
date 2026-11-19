/**
 * #829 — the fee-payer settings screen shows the address, balance and
 * derivation source, flags a random fallback, and its QR encodes the
 * fee-payer — never the smart wallet.
 */

import { Keypair, StrKey } from '@stellar/stellar-sdk';

const FEE_PAYER = Keypair.random().publicKey();
const mockSmartWallet = StrKey.encodeContract(Buffer.alloc(32, 4));

const mockGetFeePayerInfo = jest.fn();
const mockQrValues: string[] = [];

jest.mock('react-native-qrcode-svg', () => ({
  __esModule: true,
  default: (props: { value: string }) => {
    mockQrValues.push(props.value);
    return null;
  },
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#000000' }) }),
}));
jest.mock('../lib/feePayerSource', () => {
  const actual = jest.requireActual('../lib/feePayerSource');
  return {
    ...actual,
    getFeePayerInfo: (...a: unknown[]) => mockGetFeePayerInfo(...a),
    fetchFeePayerBalance: jest.fn(async () => ({ state: 'funded', xlm: '12.5000000' })),
    verifyFeePayerWithPasskey: jest.fn(),
  };
});
jest.mock('../lib/passkey', () => ({ evaluatePrf: jest.fn() }));
// The smart wallet is on the device too — the screen must not reach for it.
jest.mock('../lib/walletStore', () => ({ getWalletAddress: jest.fn(async () => mockSmartWallet) }));

import FeePayerSettingsScreen from '../app/settings/fee-payer';

// No @types package ships for react-test-renderer; this is the slice used here.
type Instance = { props: Record<string, unknown>; children: (Instance | string)[] };
type Renderer = {
  act: (fn: () => Promise<void>) => Promise<void>;
  create: (el: unknown) => { root: { findByProps: (p: object) => Instance; findAllByProps: (p: object) => Instance[] } };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer: Renderer = require('react-test-renderer');

function text(node: Instance): string {
  return node.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
}

async function render() {
  let tree!: ReturnType<Renderer['create']>;
  await renderer.act(async () => {
    tree = renderer.create(<FeePayerSettingsScreen />);
  });
  return tree.root;
}

/** The mocked comparison, reached the way the screen reaches it. */
function verifyMock(): jest.Mock {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../lib/feePayerSource').verifyFeePayerWithPasskey as jest.Mock;
}

beforeEach(() => {
  mockQrValues.length = 0;
  mockGetFeePayerInfo.mockReset();
  verifyMock().mockReset();
});

// This is the app's first component test, so the first render in this file
// pays for transforming React Native, expo-router and the screen's whole
// import graph in a cold worker — comfortably past Jest's 5s default on a
// cold CI runner, while the assertions themselves take milliseconds.
jest.setTimeout(60_000);

it('shows address, balance and a PRF derivation, with a QR of the fee-payer', async () => {
  mockGetFeePayerInfo.mockResolvedValue({ address: FEE_PAYER, source: 'prf' });
  const root = await render();

  expect(text(root.findByProps({ testID: 'fee-payer-address' }))).toBe(FEE_PAYER);
  expect(text(root.findByProps({ testID: 'fee-payer-balance' }))).toBe('12.5000000 XLM');
  expect(text(root.findByProps({ testID: 'fee-payer-source' }))).toBe('Passkey (PRF)');
  expect(root.findAllByProps({ testID: 'fee-payer-random-warning' })).toHaveLength(0);

  expect(mockQrValues.length).toBeGreaterThan(0);
  for (const value of mockQrValues) {
    expect(value).toBe(FEE_PAYER);
    expect(value).not.toBe(mockSmartWallet);
  }
});

it('identifies a random-fallback fee-payer as such', async () => {
  mockGetFeePayerInfo.mockResolvedValue({ address: FEE_PAYER, source: 'random' });
  const root = await render();

  expect(text(root.findByProps({ testID: 'fee-payer-source' }))).toBe('Random fallback');
  expect(root.findAllByProps({ testID: 'fee-payer-random-warning' }).length).toBeGreaterThan(0);
  for (const value of mockQrValues) expect(value).toBe(FEE_PAYER);
});

/**
 * The label is a stored record, not a measurement: "Passkey (PRF)" means some
 * code path asserted it. Only `verifyFeePayerWithPasskey` compares the key the
 * passkey derives against the key in use, so the button that runs it has to be
 * reachable from a wallet that already carries a label — which is precisely
 * the one worth questioning. It used to render only for `unknown`.
 */
it('offers the passkey check even when a derivation is already recorded', async () => {
  mockGetFeePayerInfo.mockResolvedValue({ address: FEE_PAYER, source: 'prf' });
  const root = await render();

  expect(text(root.findByProps({ testID: 'fee-payer-verify' }))).toBe('Re-check with passkey');
});

it('still offers it, worded as a first check, when nothing is recorded', async () => {
  mockGetFeePayerInfo.mockResolvedValue({ address: FEE_PAYER, source: 'unknown' });
  const root = await render();

  expect(text(root.findByProps({ testID: 'fee-payer-verify' }))).toBe('Check with passkey');
});

it('withholds it from a keypair wallet, which has no passkey to check against', async () => {
  mockGetFeePayerInfo.mockResolvedValue({ address: FEE_PAYER, source: 'keypair' });
  const root = await render();

  expect(root.findAllByProps({ testID: 'fee-payer-verify' })).toHaveLength(0);
});

it('says the check confirmed the label, since confirming changes nothing on screen', async () => {
  mockGetFeePayerInfo.mockResolvedValue({ address: FEE_PAYER, source: 'prf' });
  verifyMock().mockResolvedValue({ ok: true, source: 'prf' });
  const root = await render();

  await renderer.act(async () => {
    (root.findByProps({ testID: 'fee-payer-verify' }).props['onPress'] as () => void)();
  });

  expect(text(root.findByProps({ testID: 'fee-payer-verify-note' }))).toContain(
    'your passkey derives this exact address',
  );
});

it('contradicts a PRF label when the passkey derives some other key', async () => {
  mockGetFeePayerInfo.mockResolvedValue({ address: FEE_PAYER, source: 'prf' });
  verifyMock().mockResolvedValue({ ok: true, source: 'random' });
  const root = await render();

  await renderer.act(async () => {
    (root.findByProps({ testID: 'fee-payer-verify' }).props['onPress'] as () => void)();
  });

  expect(text(root.findByProps({ testID: 'fee-payer-verify-note' }))).toContain(
    'derives a different address',
  );
});
