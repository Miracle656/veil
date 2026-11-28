/**
 * Earn screen tests for Blend backstop withdrawal queue presentation.
 *
 * Verifies at the screen boundary:
 *  - The 17-day protocol withdrawal queue is stated BEFORE deposit confirmation
 *  - A queued withdrawal renders with an absolute date, both plain-language
 *    facts, and cancels in a single action (cancelling the maturity notification)
 *  - A matured withdrawal renders ready to claim and calls `withdraw()`
 */

import { Keypair, StrKey } from '@stellar/stellar-sdk';

import EarnRoute from '../app/(tabs)/earn';

const mockSigner = Keypair.random();
const mockWallet = StrKey.encodeContract(Buffer.alloc(32, 7));
const mockRouter = { replace: jest.fn(), push: jest.fn() };
const mockParams = {};
const mockNetwork = {
  name: 'mainnet',
  displayName: 'Mainnet',
  rpcUrl: 'https://rpc.example',
  horizonUrl: 'https://horizon.example',
  networkPassphrase: 'Public Global Stellar Network ; September 2015',
};
const mockWalletCtx = { wallet: { deploy: jest.fn() } };
const mockColors = new Proxy({}, { get: () => '#000000' });

const mockLoadBlendPools = jest.fn();
const mockLoadBlendPositions = jest.fn();
const mockLoadBackstopPools = jest.fn();
const mockLoadBackstopPositions = jest.fn();
const mockBuildBackstopCancelWithdrawalXdr = jest.fn();
const mockBuildBackstopWithdrawXdr = jest.fn();
const mockRequirePasskey = jest.fn();
const mockSignAndSubmitSorobanXdr = jest.fn();
const mockScheduleBackstopMaturityNotification = jest.fn();
const mockCancelBackstopMaturityNotification = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
}));
jest.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ colors: mockColors }),
}));
jest.mock('../hooks/useHiddenAmounts', () => ({
  useHiddenAmounts: () => ({ mask: (s: string) => s }),
}));
jest.mock('../hooks/useNetwork', () => ({
  useNetwork: () => ({ network: mockNetwork }),
}));
jest.mock('../components/WalletProvider', () => ({
  useWallet: () => mockWalletCtx,
}));
jest.mock('../lib/walletStore', () => ({
  getWalletAddress: jest.fn(async () => mockWallet),
  getSignerSecret: jest.fn(async () => mockSigner.secret()),
}));
jest.mock('../lib/passkey', () => ({
  requirePasskey: (...args: unknown[]) => mockRequirePasskey(...args),
}));
jest.mock('../lib/sorobanTx', () => ({
  signAndSubmitSorobanXdr: (...args: unknown[]) => mockSignAndSubmitSorobanXdr(...args),
}));
jest.mock('../lib/about', () => ({
  openExternalUrl: jest.fn(),
}));
jest.mock('../lib/earnFunding', () => ({
  fundDeposit: jest.fn(),
  loadEarnBalances: jest.fn(async () => ({ inSpending: 0, inWallet: 0 })),
}));
jest.mock('../lib/blend', () => ({
  loadBlendPools: (...args: unknown[]) => mockLoadBlendPools(...args),
  loadBlendPositions: (...args: unknown[]) => mockLoadBlendPositions(...args),
  buildBlendSupplyXdr: jest.fn(),
  buildBlendWithdrawXdr: jest.fn(),
}));
jest.mock('../lib/blendBackstop', () => {
  const actual = jest.requireActual('../lib/blendBackstop');
  return {
    ...actual,
    loadBackstopPools: (...args: unknown[]) => mockLoadBackstopPools(...args),
    loadBackstopPositions: (...args: unknown[]) => mockLoadBackstopPositions(...args),
    buildBackstopDepositXdr: jest.fn(async () => 'XDR-DEPOSIT'),
    buildBackstopQueueWithdrawalXdr: jest.fn(async () => 'XDR-QUEUE'),
    buildBackstopCancelWithdrawalXdr: (...args: unknown[]) => mockBuildBackstopCancelWithdrawalXdr(...args),
    buildBackstopWithdrawXdr: (...args: unknown[]) => mockBuildBackstopWithdrawXdr(...args),
  };
});
jest.mock('../lib/notifications', () => ({
  scheduleBackstopMaturityNotification: (...args: unknown[]) =>
    mockScheduleBackstopMaturityNotification(...args),
  cancelBackstopMaturityNotification: (...args: unknown[]) =>
    mockCancelBackstopMaturityNotification(...args),
}));

type Instance = { props: Record<string, unknown>; children: (Instance | string)[] };
type Renderer = {
  act: (fn: () => Promise<void> | void) => Promise<void>;
  create: (el: unknown) => {
    root: {
      findByProps: (p: object) => Instance;
      findAllByProps: (p: object) => Instance[];
    };
  };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer: Renderer = require('react-test-renderer');

function text(node: Instance): string {
  return node.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
}

async function renderEarn() {
  let tree!: ReturnType<Renderer['create']>;
  await renderer.act(async () => {
    tree = renderer.create(<EarnRoute />);
  });
  return tree.root;
}

const FUTURE_EXP = Math.floor(Date.now() / 1_000) + 17 * 86_400;
const PAST_EXP = Math.floor(Date.now() / 1_000) - 3_600;

jest.setTimeout(60_000);

beforeEach(() => {
  mockLoadBlendPools.mockReset().mockResolvedValue([]);
  mockLoadBlendPositions.mockReset().mockResolvedValue([]);
  mockLoadBackstopPools.mockReset().mockResolvedValue([
    { poolId: 'CPOOL1', poolName: 'Fixed', backstopId: 'CBACKSTOP1' },
  ]);
  mockLoadBackstopPositions.mockReset().mockResolvedValue([]);
  mockBuildBackstopCancelWithdrawalXdr.mockReset().mockResolvedValue('XDR-CANCEL');
  mockBuildBackstopWithdrawXdr.mockReset().mockResolvedValue('XDR-WITHDRAW');
  mockRequirePasskey.mockReset().mockResolvedValue(undefined);
  mockSignAndSubmitSorobanXdr.mockReset().mockResolvedValue('TXHASH123');
  mockScheduleBackstopMaturityNotification.mockReset().mockResolvedValue('notif-1');
  mockCancelBackstopMaturityNotification.mockReset().mockResolvedValue(undefined);
});

it('shows the 17-day protocol exit terms BEFORE a backstop deposit is confirmed', async () => {
  const root = await renderEarn();

  const openDepositBtn = root.findByProps({ testID: 'backstop-deposit-open-CPOOL1' });
  await renderer.act(() => {
    (openDepositBtn.props.onPress as () => void)();
  });

  const terms = text(root.findByProps({ testID: 'backstop-exit-terms-summary' }));
  expect(terms).toContain('17 days');
  expect(terms).toContain('Blend protocol');
  expect(terms).toContain('not a Veil policy');
  expect(root.findByProps({ testID: 'backstop-deposit-confirm' })).toBeTruthy();
});

it('cancels a queued withdrawal in one action and clears the maturity notification', async () => {
  mockLoadBackstopPositions.mockResolvedValue([
    {
      poolId: 'CPOOL1',
      poolName: 'Fixed',
      backstopId: 'CBACKSTOP1',
      shares: '0',
      tokens: '0',
      unlockedShares: '0',
      queuedWithdrawals: [
        {
          id: 'CPOOL1:queued:0',
          poolId: 'CPOOL1',
          poolName: 'Fixed',
          backstopId: 'CBACKSTOP1',
          shares: '500000000',
          tokens: '600000000',
          availableAt: FUTURE_EXP,
        },
      ],
    },
  ]);

  const root = await renderEarn();

  expect(root.findByProps({ testID: 'backstop-withdrawal-queued' })).toBeTruthy();
  expect(text(root.findByProps({ testID: 'backstop-available-date' }))).toMatch(/^Available \d+ [A-Z]/);
  expect(text(root.findByProps({ testID: 'backstop-fact-emissions' })).toLowerCase()).toContain('emissions');
  expect(text(root.findByProps({ testID: 'backstop-fact-interest' })).toLowerCase()).toContain('pool interest');

  const cancelBtn = root.findByProps({ testID: 'backstop-cancel-button' });
  await renderer.act(async () => {
    (cancelBtn.props.onPress as () => void)();
  });

  expect(mockBuildBackstopCancelWithdrawalXdr).toHaveBeenCalledWith({
    backstopId: 'CBACKSTOP1',
    poolId: 'CPOOL1',
    userAddress: mockSigner.publicKey(),
    amount: 500000000n,
  });
  expect(mockCancelBackstopMaturityNotification).toHaveBeenCalledWith('CPOOL1', FUTURE_EXP);
});

it('claims a matured withdrawal via withdraw()', async () => {
  mockLoadBackstopPositions.mockResolvedValue([
    {
      poolId: 'CPOOL1',
      poolName: 'Fixed',
      backstopId: 'CBACKSTOP1',
      shares: '0',
      tokens: '0',
      unlockedShares: '500000000',
      queuedWithdrawals: [
        {
          id: 'CPOOL1:unlocked',
          poolId: 'CPOOL1',
          poolName: 'Fixed',
          backstopId: 'CBACKSTOP1',
          shares: '500000000',
          tokens: '600000000',
          availableAt: PAST_EXP,
        },
      ],
    },
  ]);

  const root = await renderEarn();

  expect(root.findByProps({ testID: 'backstop-withdrawal-matured' })).toBeTruthy();
  const withdrawBtn = root.findByProps({ testID: 'backstop-withdraw-button' });
  await renderer.act(async () => {
    (withdrawBtn.props.onPress as () => void)();
  });

  expect(mockBuildBackstopWithdrawXdr).toHaveBeenCalledWith({
    backstopId: 'CBACKSTOP1',
    poolId: 'CPOOL1',
    userAddress: mockSigner.publicKey(),
    amount: 500000000n,
  });
  expect(mockCancelBackstopMaturityNotification).toHaveBeenCalledWith('CPOOL1', PAST_EXP);
});
