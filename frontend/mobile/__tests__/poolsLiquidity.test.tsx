import { Asset, Keypair, Networks, StrKey } from '@stellar/stellar-sdk';

const mockReadPair = jest.fn();
const mockReadPairById = jest.fn();
const mockReadBalance = jest.fn();
const mockReadLpBalance = jest.fn();
const mockInvokeAsWallet = jest.fn();
const mockLoadPositions = jest.fn();
const mockHoldings = jest.fn();
const mockPositions = { current: [] as Record<string, unknown>[] };
const mockAssetBalances = {
  wallet: { XLM: 10_000_000_000n, USDC: 10_000_000_000n },
  feePayer: { XLM: 0n, USDC: 0n },
};
const mockWalletAddress = StrKey.encodeContract(Buffer.alloc(32, 0x33));
const mockFeePayerAddress = Keypair.random().publicKey();
const network = Networks.TESTNET;
const usdcIssuer = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const tokenAId = Asset.native().contractId(network);
const tokenBId = new Asset('USDC', usdcIssuer).contractId(network);
const pairId = StrKey.encodeContract(Buffer.alloc(32, 0x44));
const routerId = 'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD';

const pair = {
  pairId,
  tokenAId,
  tokenBId,
  reserveA: 100_000_000_000n,
  reserveB: 200_000_000_000n,
  balanceA: 100_000_000_000n,
  balanceB: 200_000_000_000n,
  totalSupply: 10_000_000_000n,
  kLast: 0n,
  feesEnabled: false,
  decimalsA: 7,
  decimalsB: 7,
  lpDecimals: 7,
};

jest.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#111111' }), isDark: true }),
}));
jest.mock('../hooks/useNetwork', () => ({
  useNetwork: () => ({ networkName: 'testnet' }),
}));
jest.mock('../components/WalletProvider', () => ({
  useWallet: () => ({ wallet: { deploy: jest.fn() } }),
}));
jest.mock('../components/FlowHeader', () => ({ FlowHeader: () => null }));
jest.mock('../components/SuccessAnimation', () => ({ SuccessAnimation: () => null }));
jest.mock('../components/SlideToConfirm', () => {
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  return {
    SlideToConfirm: ({
      label,
      onConfirm,
      disabled,
      testID,
    }: {
      label: string;
      onConfirm: () => void;
      disabled?: boolean;
      testID?: string;
    }) =>
      React.createElement(
        Pressable,
        { testID, onPress: onConfirm, disabled },
        React.createElement(Text, null, label),
      ),
  };
});
jest.mock('../lib/activity', () => ({
  getFeePayerAddress: async () => mockFeePayerAddress,
}));
jest.mock('../lib/holdings', () => ({
  loadHoldings: (...args: unknown[]) => mockHoldings(...args),
}));
jest.mock('../lib/soroswapLpPositions', () => ({
  loadSoroswapLpPositions: (...args: unknown[]) => mockLoadPositions(...args),
}));
jest.mock('../lib/soroswapLiquidity', () => {
  const actual = jest.requireActual('../lib/soroswapLiquidity');
  return {
    ...actual,
    readSoroswapPair: (...args: unknown[]) => mockReadPair(...args),
    readSoroswapPairById: (...args: unknown[]) => mockReadPairById(...args),
    readLiquidityAssetBalance: (...args: unknown[]) => mockReadBalance(...args),
    readLpBalance: (...args: unknown[]) => mockReadLpBalance(...args),
    soroswapRouterId: () => routerId,
  };
});
jest.mock('../lib/contractInvoke', () => ({
  invokeAsWallet: (...args: unknown[]) => mockInvokeAsWallet(...args),
}));
jest.mock('../lib/deployWallet', () => ({
  deployWalletIfNeeded: jest.fn(async () => undefined),
}));
jest.mock('../lib/walletStore', () => ({
  getWalletAddress: async () => mockWalletAddress,
}));
jest.mock('../lib/network', () => ({
  getNetwork: () => ({
    name: 'testnet',
    networkPassphrase: 'Test SDF Network ; September 2015',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    horizonUrl: 'https://horizon-testnet.stellar.org',
  }),
}));

import PoolsScreen from '../app/pools';

type Instance = {
  props: Record<string, unknown>;
  children: (Instance | string)[];
};
type Renderer = {
  act: (fn: () => Promise<void>) => Promise<void>;
  create: (element: unknown) => {
    root: {
      findAllByProps: (props: object) => Instance[];
    };
  };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer: Renderer = require('react-test-renderer');

function text(node: Instance | string): string {
  if (typeof node === 'string') return node;
  return node.children.map(text).join(' ').replace(/\s+/g, ' ').trim();
}

async function settle() {
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function flush() {
  await renderer.act(async () => {
    await settle();
  });
}

async function renderScreen() {
  let tree!: ReturnType<Renderer['create']>;
  await renderer.act(async () => {
    tree = renderer.create(<PoolsScreen />);
    await settle();
  });
  return tree.root;
}

function find(root: ReturnType<Renderer['create']>['root'], testID: string): Instance {
  const nodes = root.findAllByProps({ testID });
  const node =
    nodes.find(
      (candidate) =>
        typeof candidate.props.onPress === 'function' ||
        typeof candidate.props.onChangeText === 'function',
    ) ?? nodes[0];
  if (!node) throw new Error(`Could not find ${testID}`);
  return node;
}

async function press(root: ReturnType<Renderer['create']>['root'], testID: string) {
  const node = find(root, testID);
  await renderer.act(async () => {
    const handler = node.props.onPress;
    if (typeof handler === 'function') await handler();
    await settle();
  });
}

async function setInput(
  root: ReturnType<Renderer['create']>['root'],
  testID: string,
  value: string,
) {
  const input = find(root, testID);
  await renderer.act(async () => {
    const handler = input.props.onChangeText;
    if (typeof handler !== 'function') throw new Error(`${testID} is not editable`);
    handler(value);
    await settle();
  });
}

async function prepareAdd(root: ReturnType<Renderer['create']>['root']) {
  await setInput(root, 'liquidity-amount-a', '1');
  await flush();
}

async function reviewAdd(root: ReturnType<Renderer['create']>['root']) {
  await press(root, 'liquidity-review-button');
  await flush();
}

async function confirm(root: ReturnType<Renderer['create']>['root']) {
  await press(root, 'liquidity-confirm');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPositions.current = [];
  mockAssetBalances.wallet.XLM = 10_000_000_000n;
  mockAssetBalances.wallet.USDC = 10_000_000_000n;
  mockAssetBalances.feePayer.XLM = 0n;
  mockAssetBalances.feePayer.USDC = 0n;
  mockHoldings.mockResolvedValue([]);
  mockLoadPositions.mockImplementation(async () => mockPositions.current);
  mockReadPair.mockResolvedValue({ kind: 'found', pair });
  mockReadPairById.mockResolvedValue(pair);
  mockReadBalance.mockImplementation(async (owner: string, asset: { code: string }) => {
    const side = owner === mockWalletAddress ? 'wallet' : 'feePayer';
    return mockAssetBalances[side][asset.code as 'XLM' | 'USDC'];
  });
  mockReadLpBalance.mockResolvedValue(500_000_000n);
  mockInvokeAsWallet.mockResolvedValue('mock-transaction-hash');
});

it('shows ratio, minted estimate, pool share, and minimums before adding; nothing moves before confirm', async () => {
  const root = await renderScreen();
  await prepareAdd(root);

  expect(find(root, 'liquidity-slippage').props.value).toBe('0.50');
  expect(root.findAllByProps({}).map(text).join(' ')).not.toMatch(/\b(?:APR|APY|yield)\b/i);
  const counter = find(root, 'liquidity-counter-amount');
  expect(text(counter)).toContain('2 USDC');
  expect(root.findAllByProps({ testID: 'liquidity-review-button' })[0]?.props.disabled).toBe(false);
  expect(mockInvokeAsWallet).not.toHaveBeenCalled();

  await reviewAdd(root);
  const reviewText = root.findAllByProps({}).map(text).join(' ');
  expect(reviewText).toMatch(/estimated LP tokens/i);
  expect(reviewText).toContain('Estimated pool share');
  expect(reviewText).toMatch(/minimum amounts accepted/i);
  expect(reviewText).toContain('The router accepts minimum amounts for both assets');
  expect(mockInvokeAsWallet).not.toHaveBeenCalled();

  await confirm(root);
  expect(mockInvokeAsWallet).toHaveBeenCalledTimes(1);
  expect(mockInvokeAsWallet).toHaveBeenCalledWith(
    routerId,
    'add_liquidity',
    expect.any(Array),
  );
}, 15000);

it('shows a one-sided shortage before review and blocks confirmation', async () => {
  mockAssetBalances.wallet.USDC = 0n;
  const root = await renderScreen();
  await prepareAdd(root);

  const shortage = find(root, 'liquidity-shortage');
  expect(text(shortage)).toMatch(/short 2 USDC/i);
  expect(text(shortage)).toMatch(/swap some XLM into USDC first/i);
  expect(root.findAllByProps({ testID: 'liquidity-review-button' })[0]?.props.disabled).toBe(true);
  expect(mockInvokeAsWallet).not.toHaveBeenCalled();
});

it('stops when the pair does not exist and builds no transaction', async () => {
  mockReadPair.mockResolvedValue({ kind: 'missing' });
  const root = await renderScreen();
  await flush();

  expect(text(find(root, 'liquidity-pair-missing'))).toMatch(/cannot create a pair/i);
  expect(root.findAllByProps({ testID: 'liquidity-review-button' })[0]?.props.disabled).toBe(true);
  expect(mockInvokeAsWallet).not.toHaveBeenCalled();
});

it('keeps the impermanent-loss warning on the add form before confirmation', async () => {
  const root = await renderScreen();
  const warning = find(root, 'liquidity-impact-warning');
  expect(text(warning)).toContain('Providing liquidity changes the ratio of what you hold');
});

it('warns on high slippage and disables review for values outside the allowed range', async () => {
  const root = await renderScreen();
  await setInput(root, 'liquidity-slippage', '1.01');
  expect(root.findAllByProps({}).map(text).join(' ')).toMatch(/High slippage tolerance/i);

  await setInput(root, 'liquidity-slippage', '5.01');
  expect(root.findAllByProps({}).map(text).join(' ')).toMatch(/between 0.10% and 5.00%/i);
  expect(root.findAllByProps({ testID: 'liquidity-review-button' })[0]?.props.disabled).toBe(true);
});

it('moves held spending-account assets into the smart wallet before the router add', async () => {
  mockAssetBalances.wallet.XLM = 0n;
  mockAssetBalances.wallet.USDC = 0n;
  mockAssetBalances.feePayer.XLM = 10_000_000n;
  mockAssetBalances.feePayer.USDC = 20_000_000n;
  const root = await renderScreen();
  await prepareAdd(root);
  await reviewAdd(root);
  expect(mockInvokeAsWallet).not.toHaveBeenCalled();
  await confirm(root);

  const operations = mockInvokeAsWallet.mock.calls.map(([contractId, method]) => [contractId, method]);
  expect(operations).toEqual([
    [tokenAId, 'transfer'],
    [tokenBId, 'transfer'],
    [routerId, 'add_liquidity'],
  ]);
});

it('shows a slippage-specific error and retry after the router rejects minimums', async () => {
  mockInvokeAsWallet.mockRejectedValue(new Error('Error(Contract, #505)'));
  const root = await renderScreen();
  await prepareAdd(root);
  await reviewAdd(root);
  await confirm(root);

  const pageText = root.findAllByProps({}).map(text).join(' ');
  expect(pageText).toMatch(/pool moved beyond your slippage limit/i);
  expect(pageText).toMatch(/Refresh the quote and try again/i);
  expect(
    root.findAllByProps({ testID: 'liquidity-refresh-quote' }).some(
      (node) => typeof node.props.onPress === 'function',
    ),
  ).toBe(true);
});

it('estimates both removal assets and submits the router removal call', async () => {
  mockPositions.current = [
    {
      pairId,
      tokenAId,
      tokenBId,
      tokenA: 'XLM',
      tokenB: 'USDC',
      lpBalance: '50',
      lpBalanceRaw: '500000000',
      ownerBalances: [{ address: mockWalletAddress, raw: '500000000' }],
      ownershipPercent: '5.00',
      underlyingA: '50',
      underlyingB: '100',
      usd: null,
    },
  ];
  const root = await renderScreen();
  await press(root, 'liquidity-mode-remove');
  await flush();
  await press(root, 'liquidity-remove-50');

  const estimate = find(root, 'liquidity-remove-estimate');
  expect(text(estimate)).toContain('250 XLM');
  expect(text(estimate)).toContain('500 USDC');
  expect(mockInvokeAsWallet).not.toHaveBeenCalled();

  await press(root, 'liquidity-review-button');
  const reviewText = root.findAllByProps({}).map(text).join(' ');
  expect(reviewText).toContain('Removing returns both assets in the pool');
  expect(reviewText).toMatch(/minimum amounts accepted/i);
  await confirm(root);

  expect(mockInvokeAsWallet).toHaveBeenCalledWith(
    routerId,
    'remove_liquidity',
    expect.any(Array),
  );
});
