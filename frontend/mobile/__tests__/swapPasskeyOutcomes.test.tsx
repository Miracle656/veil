/**
 * #1183 — the swap screen's passkey ceremony has the same three outcomes.
 *
 * A dismissal belongs back on the review screen the user came from, not on a
 * failure banner. A refusal says what the authenticator needs. A genuine
 * failure says nothing was sent.
 */

import { Keypair, StrKey } from '@stellar/stellar-sdk';

const mockRequirePasskey = jest.fn();
const mockSwap = jest.fn();
const mockSwapXdr = jest.fn();
const mockWallet = StrKey.encodeContract(Buffer.alloc(32, 8));
const mockSecret = Keypair.random().secret();

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ from: 'XLM', to: 'USDC', amount: '1' }),
}));
jest.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#000000' }), isDark: false }),
}));
jest.mock('../hooks/useNetwork', () => ({
  useNetwork: () => ({
    networkName: 'testnet',
    network: {
      name: 'testnet',
      displayName: 'Testnet',
      rpcUrl: 'https://soroban-testnet.stellar.org',
      horizonUrl: 'https://horizon-testnet.stellar.org',
      networkPassphrase: 'Test SDF Network ; September 2015',
    },
  }),
}));
jest.mock('../components/WalletProvider', () => ({
  useWallet: () => ({ wallet: { deploy: jest.fn() } }),
}));
jest.mock('../components/FlowHeader', () => ({ FlowHeader: () => null }));
jest.mock('../components/TokenIcon', () => ({ TokenIcon: () => null }));
jest.mock('../components/SuccessAnimation', () => ({ SuccessAnimation: () => null }));
jest.mock('../components/PreConfirmationPanel', () => ({ PreConfirmationPanel: () => null }));
jest.mock('../components/icons', () => ({ SwapVerticalIcon: () => null }));
jest.mock('../components/SlideToConfirm', () => {
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  return {
    SlideToConfirm: ({ label, onConfirm, testID }: { label: string; onConfirm: () => void; testID?: string }) =>
      React.createElement(
        Pressable,
        { testID: testID ?? 'swap-confirm', onPress: onConfirm },
        React.createElement(Text, null, label),
      ),
  };
});
jest.mock('../lib/passkey', () => ({
  requirePasskey: (...args: unknown[]) => mockRequirePasskey(...args),
}));
jest.mock('../lib/network', () => ({
  getNetwork: () => ({
    name: 'testnet',
    displayName: 'Testnet',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
  }),
  getNetworkName: () => 'testnet',
}));
jest.mock('../lib/walletStore', () => ({
  getWalletAddress: jest.fn(async () => mockWallet),
  getSignerSecret: jest.fn(async () => mockSecret),
}));
jest.mock('../lib/holdings', () => ({ loadHoldings: jest.fn(async () => []) }));
jest.mock('../lib/activity', () => ({
  fetchContractAssetBalance: jest.fn(async () => 0),
  getFeePayerAddress: jest.fn(async () => null),
}));
jest.mock('../lib/contractSpend', () => ({
  getFeePayerXlm: jest.fn(async () => ({ balance: 0, subentries: 0, reserve: 0, spendable: 0 })),
  sendAssetFromContract: (...args: unknown[]) => mockSwapXdr(...args),
}));
jest.mock('../lib/deployWallet', () => ({ deployWalletIfNeeded: jest.fn(async () => undefined) }));
jest.mock('../lib/sorobanTx', () => ({ signAndSubmitSorobanXdr: jest.fn(async () => 'abc') }));
jest.mock('../lib/sdexSwap', () => ({
  getSdexQuote: jest.fn(async () => ({ amountOut: '1', path: [] })),
  sdexSwap: (...args: unknown[]) => mockSwap(...args),
}));
jest.mock('../lib/soroswap', () => ({
  getSoroswapQuote: jest.fn(),
  buildSoroswapSwapXdr: jest.fn(),
  ensureSwapOutTrustline: jest.fn(async () => undefined),
}));
jest.mock('../lib/soroswapEnhanced', () => ({
  enhanceQuoteWithSpread: jest.fn(async () => ({
    shouldRefuse: false,
    refusalReason: null,
    impactAnalysis: null,
    spread: null,
    reverseQuote: null,
  })),
}));

import {
  PASSKEY_CANCELLED_MESSAGE,
  PASSKEY_UNSUPPORTED_MESSAGE,
  PasskeyCeremonyError,
} from '../lib/passkeyOutcome';
import SwapScreen from '../app/swap';

type Instance = { props: Record<string, unknown>; children: (Instance | string)[] };
type Renderer = {
  act: (fn: () => Promise<void>) => Promise<void>;
  create: (el: unknown) => { root: { findAllByProps: (p: object) => Instance[] } };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer: Renderer = require('react-test-renderer');

function text(node: Instance): string {
  return node.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
}

async function renderAtReview() {
  let tree!: ReturnType<Renderer['create']>;
  await renderer.act(async () => {
    tree = renderer.create(<SwapScreen />);
  });
  // The quote is debounced; wait past it, then review the quote on screen.
  await renderer.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 750));
  });

  const review = tree.root
    .findAllByProps({ testID: 'swap-review-button' })
    .find((node) => typeof node.props.onPress === 'function');
  if (!review) throw new Error('review control not found — the quote never loaded');

  await renderer.act(async () => {
    (review.props.onPress as () => void)();
  });
  return tree.root;
}

async function confirmSwap(root: ReturnType<Renderer['create']>['root']) {
  const confirm = root
    .findAllByProps({ testID: 'swap-confirm' })
    .find((node) => typeof node.props.onPress === 'function');
  if (!confirm) throw new Error('swap confirmation control not found');
  await renderer.act(async () => {
    await (confirm.props.onPress as () => Promise<void>)();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

jest.setTimeout(60_000);

it('cancelling returns to the review screen with no error', async () => {
  mockRequirePasskey.mockRejectedValue(
    new PasskeyCeremonyError('cancelled', PASSKEY_CANCELLED_MESSAGE),
  );

  const root = await renderAtReview();
  await confirmSwap(root);

  expect(root.findAllByProps({ testID: 'swap-review-screen' }).length).toBeGreaterThan(0);
  expect(root.findAllByProps({ testID: 'swap-error' })).toHaveLength(0);
  expect(mockSwap).not.toHaveBeenCalled();
  expect(mockSwapXdr).not.toHaveBeenCalled();
});

it('an authenticator refusal explains what to try', async () => {
  mockRequirePasskey.mockRejectedValue(
    new PasskeyCeremonyError('refused', PASSKEY_UNSUPPORTED_MESSAGE),
  );

  const root = await renderAtReview();
  await confirmSwap(root);

  const errors = root.findAllByProps({ testID: 'swap-error' });
  expect(errors.length).toBeGreaterThan(0);
  expect(text(errors[0])).toMatch(/does not support/i);
  expect(text(errors[0])).toMatch(/different device|passkey manager/i);
  expect(mockSwap).not.toHaveBeenCalled();
});

it('reports a submission timeout instead of pretending the user cancelled', async () => {
  // The passkey was accepted; the timeout came from the router/Horizon while
  // submitting. It must reach the error state, not return to the review screen.
  mockRequirePasskey.mockResolvedValue(undefined);
  mockSwap.mockRejectedValue(new Error('timeout of 30000ms exceeded'));

  const root = await renderAtReview();
  await confirmSwap(root);

  expect(mockSwap).toHaveBeenCalledTimes(1);
  const errors = root.findAllByProps({ testID: 'swap-error' });
  expect(errors.length).toBeGreaterThan(0);
  expect(text(errors[0])).toMatch(/timeout of 30000ms exceeded/i);
});

it('a genuine failure says nothing was sent', async () => {
  mockRequirePasskey.mockRejectedValue(
    new PasskeyCeremonyError(
      'failed',
      'The signing request was interrupted. Nothing was sent. Please try again.',
    ),
  );

  const root = await renderAtReview();
  await confirmSwap(root);

  const errors = root.findAllByProps({ testID: 'swap-error' });
  expect(errors.length).toBeGreaterThan(0);
  expect(text(errors[0])).toMatch(/Nothing was sent/i);
  expect(mockSwap).not.toHaveBeenCalled();
});
