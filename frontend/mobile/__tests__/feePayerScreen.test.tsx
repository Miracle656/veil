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

beforeEach(() => {
  mockQrValues.length = 0;
  mockGetFeePayerInfo.mockReset();
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
