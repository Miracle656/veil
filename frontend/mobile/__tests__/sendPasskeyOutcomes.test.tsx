/**
 * #1183 — a dismissed passkey prompt is not a failed payment.
 *
 * The send screen is one of the spend paths this issue names. These tests pin
 * the three outcomes at the screen boundary: cancellation returns to the filled
 * form with no error and no send, a refusal explains what to try, and a genuine
 * failure still reports itself without pretending money moved.
 */

import { StrKey } from '@stellar/stellar-sdk';

const mockRecipient = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const mockWallet = StrKey.encodeContract(Buffer.alloc(32, 9));

const mockRequirePasskey = jest.fn();
const mockSendPayment = jest.fn();
const mockDeploy = jest.fn();

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ to: mockRecipient, amount: '1' }),
}));
jest.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#000000' }), isDark: false }),
}));
jest.mock('../hooks/useCurrency', () => ({ useCurrency: () => ({ format: (n: number) => String(n) }) }));
jest.mock('../hooks/useHiddenAmounts', () => ({ useHiddenAmounts: () => ({ mask: (s: string) => s }) }));
jest.mock('../components/WalletProvider', () => ({
  useWallet: () => ({ wallet: { deploy: mockDeploy } }),
}));
jest.mock('../components/FlowHeader', () => ({ FlowHeader: () => null }));
jest.mock('../components/ContactPicker', () => ({ ContactPicker: () => null }));
jest.mock('../components/QrScanner', () => ({ QrScanner: () => null }));
jest.mock('../components/TokenIcon', () => ({ TokenIcon: () => null }));
jest.mock('../components/SuccessAnimation', () => ({ SuccessAnimation: () => null }));
jest.mock('../components/SlideToConfirm', () => {
  const React = require('react');
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
  requirePasskey: (...args: unknown[]) => mockRequirePasskey(...args),
}));
jest.mock('../lib/signer', () => ({
  requireSigner: jest.fn(async () => ({ publicKey: 'G', sign: jest.fn() })),
}));
jest.mock('../lib/walletStore', () => ({ getWalletAddress: jest.fn(async () => mockWallet) }));
jest.mock('../lib/holdings', () => ({
  loadHoldings: jest.fn(async () => [
    { code: 'XLM', issuer: null, native: true, balance: '10' },
  ]),
  unitPrice: () => null,
}));
jest.mock('../lib/activity', () => ({
  fetchContractAssetBalance: jest.fn(async () => 0),
}));
jest.mock('../lib/contractSpend', () => ({
  getFeePayerSpendableXlm: jest.fn(async () => 0),
  getFeePayerXlm: jest.fn(async () => ({ balance: 0, subentries: 0, reserve: 0, spendable: 0 })),
}));
jest.mock('../lib/deployWallet', () => ({ deployWalletIfNeeded: jest.fn(async () => undefined) }));
jest.mock('../lib/sendPayment', () => ({
  sendPayment: (...args: unknown[]) => mockSendPayment(...args),
}));

import {
  PASSKEY_CANCELLED_MESSAGE,
  PASSKEY_UNSUPPORTED_MESSAGE,
  PasskeyCeremonyError,
} from '../lib/passkeyOutcome';
import SendScreen from '../app/send';

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
    tree = renderer.create(<SendScreen />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return tree.root;
}

async function pressSend(root: ReturnType<Renderer['create']>['root']) {
  const submit = root
    .findAllByProps({ testID: 'send-submit' })
    .find((node) => typeof node.props.onPress === 'function');
  if (!submit) throw new Error('send submit control not found');
  await renderer.act(async () => {
    await (submit.props.onPress as () => Promise<void>)();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

jest.setTimeout(60_000);

it('returns to the filled form with no error when the user cancels', async () => {
  mockRequirePasskey.mockRejectedValue(
    new PasskeyCeremonyError('cancelled', PASSKEY_CANCELLED_MESSAGE),
  );

  const root = await render();
  await pressSend(root);

  expect(root.findAllByProps({ testID: 'send-error' })).toHaveLength(0);
  expect(root.findAllByProps({ testID: 'send-screen' }).length).toBeGreaterThan(0);
  // Still on the form: the slider is offered again, not a "Try again" error.
  expect(root.findAllByProps({ testID: 'send-submit' }).length).toBeGreaterThan(0);
  expect(mockSendPayment).not.toHaveBeenCalled();
});

it('explains an authenticator refusal and offers the next step', async () => {
  mockRequirePasskey.mockRejectedValue(
    new PasskeyCeremonyError('refused', PASSKEY_UNSUPPORTED_MESSAGE),
  );

  const root = await render();
  await pressSend(root);

  const error = root.findByProps({ testID: 'send-error' });
  expect(text(error)).toMatch(/does not support/i);
  expect(text(error)).toMatch(/different device|passkey manager/i);
  expect(mockSendPayment).not.toHaveBeenCalled();
});

it('reports a submission timeout instead of silently returning to the form', async () => {
  // A Horizon/axios timeout during submission happens AFTER the passkey was
  // accepted, and the transaction may already be on the network. Treating the
  // word "timeout" as a cancellation returned to the form with nothing said.
  mockRequirePasskey.mockResolvedValue(undefined);
  mockSendPayment.mockRejectedValue(new Error('timeout of 30000ms exceeded'));

  const root = await render();
  await pressSend(root);

  expect(mockSendPayment).toHaveBeenCalledTimes(1);
  const error = root.findByProps({ testID: 'send-error' });
  expect(text(error)).toMatch(/timeout of 30000ms exceeded/i);
});

it('reports "request timed out" from the network as an error, not a decline', async () => {
  mockRequirePasskey.mockResolvedValue(undefined);
  mockSendPayment.mockRejectedValue(new Error('request timed out'));

  const root = await render();
  await pressSend(root);

  const error = root.findByProps({ testID: 'send-error' });
  expect(text(error)).toMatch(/request timed out/i);
  expect(mockSendPayment).toHaveBeenCalledTimes(1);
});

it('reports a genuine failure without claiming a payment was sent', async () => {
  mockRequirePasskey.mockRejectedValue(
    new PasskeyCeremonyError(
      'failed',
      'The signing request was interrupted. Nothing was sent. Please try again.',
    ),
  );

  const root = await render();
  await pressSend(root);

  const error = root.findByProps({ testID: 'send-error' });
  expect(text(error)).toMatch(/interrupted/i);
  expect(text(error)).toMatch(/Nothing was sent/i);
  expect(mockSendPayment).not.toHaveBeenCalled();
});
