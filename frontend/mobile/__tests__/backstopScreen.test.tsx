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
jest.mock('../lib/passkey', () => ({ requirePasskey: jest.fn(async () => undefined) }));
jest.mock('../lib/sorobanTx', () => ({ signAndSubmitSorobanXdr: jest.fn(async () => 'HASH') }));
jest.mock('../lib/feePayerCheck', () => ({ assertFeePayerCanCoverBackstop: jest.fn(async () => undefined) }));
jest.mock('../lib/blend', () => {
  const actual = jest.requireActual('../lib/blend');
  return {
    ...actual,
    loadBackstopOverview: (...a: unknown[]) => mockOverview(...a),
    loadBackstopLpBalance: jest.fn(async () => 500n * 10_000_000n),
    buildBackstopActionXdr: jest.fn(async () => 'XDR'),
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

beforeEach(() => mockOverview.mockReset());

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

it('renders the first-loss disclosure with all 3 sentences before deposit', async () => {
  mockOverview.mockResolvedValue({ pools: [pool], positions: [], failedPoolIds: [] });
  const root = await render();

  await renderer.act(async () => {
    (root.findAllByProps({ label: 'Deposit' })[0].props.onPress as () => void)();
  });

  const disclosure = root.findByProps({ testID: 'backstop-disclosure' });
  expect(disclosure).toBeDefined();

  const sentence1 = text(root.findByProps({ testID: 'backstop-sentence-insuring' }));
  expect(sentence1).toContain('You are insuring this pool, and you are paid for it.');

  const sentence2 = text(root.findByProps({ testID: 'backstop-sentence-loss' }));
  expect(sentence2).toContain('17 days');
  expect(sentence2).toContain('share value falls');

  const sentence3 = text(root.findByProps({ testID: 'backstop-sentence-not-savings' }));
  expect(sentence3).toContain('not a savings account and not a deposit');
});
