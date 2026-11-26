/**
 * The backstop screen: it says a share's value can fall before the first
 * deposit, shows what the position is worth NOW rather than what went in, keeps
 * emissions on a line of their own, and will not take a first deposit until the
 * risk has been acknowledged.
 */

import { Keypair } from '@stellar/stellar-sdk';

const mockSigner = Keypair.random();
const E7 = 10_000_000n;

const mockOverview = jest.fn();
const mockQueueLength = jest.fn();
const mockCalls: string[] = [];

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn(), back: jest.fn() }),
}));
jest.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#000000' }) }),
}));
jest.mock('../hooks/useHiddenAmounts', () => ({
  useHiddenAmounts: () => ({ mask: (v: string) => v }),
}));
jest.mock('../hooks/useNetwork', () => ({
  useNetwork: () => ({
    network: {
      name: 'testnet',
      displayName: 'Testnet',
      rpcUrl: 'https://rpc.test',
      horizonUrl: 'https://horizon.test',
      networkPassphrase: 'Test SDF Network ; September 2015',
    },
  }),
}));
jest.mock('../lib/walletStore', () => ({
  getWalletAddress: jest.fn(async () => 'CWALLET'),
  getSignerSecret: jest.fn(async () => mockSigner.secret()),
}));
jest.mock('../lib/passkey', () => ({
  requirePasskey: jest.fn(async () => {
    mockCalls.push('passkey');
  }),
}));
jest.mock('../lib/sorobanTx', () => ({ signAndSubmitSorobanXdr: jest.fn(async () => 'HASH') }));
jest.mock('../lib/feePayerCheck', () => ({
  assertFeePayerCanCoverBackstop: jest.fn(async () => {
    mockCalls.push('feePayer');
  }),
}));
jest.mock('../lib/blend', () => {
  const actual = jest.requireActual('../lib/blend');
  return {
    ...actual,
    loadBackstopOverview: (...a: unknown[]) => mockOverview(...a),
    loadBackstopLpBalance: jest.fn(async () => 500n * 10_000_000n),
    buildBackstopActionXdr: jest.fn(async () => 'XDR'),
    loadBackstopQueueLength: (...a: unknown[]) => mockQueueLength(...a),
  };
});

import { BACKSTOP_RISK_NOTICE } from '../lib/blend';
import BackstopRoute from '../app/backstop';

type Instance = { props: Record<string, unknown>; children: (Instance | string)[] };
type Renderer = {
  act: (fn: () => Promise<void> | void) => Promise<void>;
  create: (el: unknown) => {
    root: { findByProps: (p: object) => Instance; findAllByProps: (p: object) => Instance[] };
  };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer: Renderer = require('react-test-renderer');

function text(node: Instance): string {
  return node.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
}

async function render() {
  let tree!: ReturnType<Renderer['create']>;
  await renderer.act(async () => {
    tree = renderer.create(<BackstopRoute />);
  });
  return tree.root;
}

const pool = {
  poolId: 'CPOOL',
  poolName: 'Fixed',
  backstopId: 'CBACKSTOP',
  lpToken: 'CLP',
  sharePrice: 0.9,
  queuedFraction: 0,
};

const position = {
  ...pool,
  activeShares: (100n * E7).toString(),
  queued: [],
  unlockedShares: '0',
  // 100 shares bought at par, now worth 90 after a draw.
  lpTokens: (90n * E7).toString(),
  usdValue: 180,
  emissionsBlnd: 12.5,
};

jest.setTimeout(60_000);

beforeEach(() => {
  mockOverview.mockReset();
  mockQueueLength.mockReset();
  mockCalls.length = 0;
});

it('states that a share can fall before anyone can make a first deposit', async () => {
  mockOverview.mockResolvedValue({ pools: [pool], positions: [], failedPoolIds: [] });

  const root = await render();

  expect(BACKSTOP_RISK_NOTICE).toMatch(/can fall/);
  const all = root.findAllByProps({ children: BACKSTOP_RISK_NOTICE });
  expect(all.length).toBeGreaterThan(0);
  // The pool's Deposit button is on screen too, so the notice is already there when it is reached.
  expect(root.findAllByProps({ label: 'Deposit' }).length).toBeGreaterThan(0);
});

it('shows the CURRENT value, not the deposited amount, and flags a share below par', async () => {
  mockOverview.mockResolvedValue({ pools: [pool], positions: [position], failedPoolIds: [] });

  const root = await render();

  const value = text(root.findByProps({ testID: 'backstop-current-value' }));
  expect(value).toContain('90');
  expect(value).not.toContain('100');
  expect(text(root.findByProps({ testID: 'backstop-share-price' }))).toMatch(/0\.9000.*Below 1/);
});

it('keeps emissions on their own line, out of the position value', async () => {
  mockOverview.mockResolvedValue({ pools: [pool], positions: [position], failedPoolIds: [] });

  const root = await render();

  expect(text(root.findByProps({ testID: 'backstop-emissions' }))).toContain('12.5 BLND');
  expect(text(root.findByProps({ testID: 'backstop-current-value' }))).not.toContain('BLND');
});

it('keeps a first deposit disabled until the risk is acknowledged', async () => {
  mockOverview.mockResolvedValue({ pools: [pool], positions: [], failedPoolIds: [] });
  const root = await render();

  await renderer.act(async () => {
    (root.findAllByProps({ label: 'Deposit' })[0].props.onPress as () => void)();
  });
  await renderer.act(async () => {
    (root.findByProps({ accessibilityLabel: 'Deposit amount' }).props.onChangeText as (v: string) => void)('10');
  });

  const depositButton = () => root.findAllByProps({ label: 'Deposit' }).find((n) => 'disabled' in n.props)!;
  expect(depositButton().props.disabled).toBe(true);

  await renderer.act(async () => {
    (root.findAllByProps({ accessibilityRole: 'checkbox' })[0].props.onPress as () => void)();
  });
  expect(depositButton().props.disabled).toBe(false);
});

const press = (root: { findAllByProps: (p: object) => Instance[] }, label: string) =>
  renderer.act(async () => {
    (root.findAllByProps({ label })[0].props.onPress as () => void)();
  });

it('stops at a confirm step that states the amount and queue length before queuing', async () => {
  mockOverview.mockResolvedValue({ pools: [pool], positions: [position], failedPoolIds: [] });
  mockQueueLength.mockResolvedValue({ expiresAt: 0, seconds: 17 * 86400 });
  const root = await render();

  await press(root, 'Queue withdrawal');

  expect(mockCalls).toEqual([]); // no fee check, no passkey yet
  expect(text(root.findByProps({ testID: 'backstop-confirm-amount' }))).toContain('100 shares');
  expect(text(root.findByProps({ testID: 'backstop-confirm-queue' }))).toContain('17 days');
});

it('cannot confirm a queue whose length could not be read', async () => {
  mockOverview.mockResolvedValue({ pools: [pool], positions: [position], failedPoolIds: [] });
  mockQueueLength.mockRejectedValue(new Error('rpc down'));
  const root = await render();

  await press(root, 'Queue withdrawal');

  expect(root.findAllByProps({ label: 'Confirm and queue' })[0].props.disabled).toBe(true);
});

it('stops at a confirm step before cancelling a queued withdrawal', async () => {
  const queued = {
    ...position,
    activeShares: '0',
    queued: [{ shares: (40n * E7).toString(), lpTokens: '1', expiresAt: 1_900_000_000 }],
  };
  mockOverview.mockResolvedValue({ pools: [pool], positions: [queued], failedPoolIds: [] });
  const root = await render();

  await press(root, 'Cancel queued withdrawal');

  expect(mockCalls).toEqual([]);
  expect(text(root.findByProps({ testID: 'backstop-confirm-amount' }))).toContain('40 shares');
});

it('checks the fee-payer before asking for the passkey', async () => {
  mockOverview.mockResolvedValue({ pools: [pool], positions: [position], failedPoolIds: [] });
  mockQueueLength.mockResolvedValue({ expiresAt: 0, seconds: 17 * 86400 });
  const root = await render();

  await press(root, 'Queue withdrawal');
  await press(root, 'Confirm and queue');

  expect(mockCalls.slice(0, 2)).toEqual(['feePayer', 'passkey']);
});
