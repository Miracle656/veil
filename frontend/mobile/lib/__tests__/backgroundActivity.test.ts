const mockLoadActivity = jest.fn();
const mockGetWalletAddress = jest.fn();
const mockFire = jest.fn();
const mockStorage = new Map<string, string>();
let mockAppState = 'background';

jest.mock('expo-background-task', () => ({
  BackgroundTaskResult: { Success: 1, Failed: 2 },
  BackgroundTaskStatus: { Restricted: 1, Available: 2 },
  getStatusAsync: jest.fn(),
  registerTaskAsync: jest.fn(),
}));
jest.mock('expo-task-manager', () => ({ defineTask: jest.fn() }));
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: {
    get currentState() {
      return mockAppState;
    },
  },
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: async (k: string) => mockStorage.get(k) ?? null,
  setItem: async (k: string, v: string) => void mockStorage.set(k, v),
}));
jest.mock('../activityFeed', () => ({
  movementKey: (r: { hash?: string; id: string }) => r.hash ?? r.id,
}));
jest.mock('../horizonActivity', () => ({ loadHorizonActivity: (...a: unknown[]) => mockLoadActivity(...a) }));
jest.mock('../network', () => ({ hydrateNetwork: async () => 'mainnet' }));
jest.mock('../notifications', () => ({ fireTransferNotification: (...a: unknown[]) => mockFire(...a) }));
jest.mock('../walletStore', () => ({ getWalletAddress: () => mockGetWalletAddress() }));

import { checkForNewActivity } from '../backgroundActivity';
import { __resetNotifiedMovementsForTest } from '../notifiedMovements';

const received = (hash: string) => ({
  id: `op-${hash}`,
  type: 'received',
  amount: '5',
  asset: 'USDC',
  counterparty: 'GSENDER',
  timestamp: 1,
  hash,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockStorage.clear();
  __resetNotifiedMovementsForTest();
  mockAppState = 'background';
  mockGetWalletAddress.mockResolvedValue('CWALLET');
  mockFire.mockResolvedValue(undefined);
});

it('notifies about a payment that arrived while the app was closed, without the amount', async () => {
  mockStorage.set('veil_notified_movements', JSON.stringify(['old']));
  mockLoadActivity.mockResolvedValue([received('new'), received('old')]);

  await expect(checkForNewActivity()).resolves.toBe(1);

  expect(mockFire).toHaveBeenCalledTimes(1);
  expect(mockFire).toHaveBeenCalledWith(expect.objectContaining({ hash: 'new', hideAmount: true }));
  expect(JSON.parse(mockStorage.get('veil_notified_movements')!)).toEqual(['old', 'new']);
});

it('does not announce the same payment on the next pass', async () => {
  mockStorage.set('veil_notified_movements', JSON.stringify(['old']));
  mockLoadActivity.mockResolvedValue([received('new')]);

  await checkForNewActivity();
  await checkForNewActivity();

  expect(mockFire).toHaveBeenCalledTimes(1);
});

it('stays quiet on a fresh install, where all history would look new', async () => {
  mockLoadActivity.mockResolvedValue([received('a'), received('b')]);

  await expect(checkForNewActivity()).resolves.toBe(0);
  expect(mockFire).not.toHaveBeenCalled();
});

it('leaves the foreground to the in-app poll', async () => {
  mockAppState = 'active';
  mockStorage.set('veil_notified_movements', JSON.stringify([]));

  await expect(checkForNewActivity()).resolves.toBe(0);
  expect(mockLoadActivity).not.toHaveBeenCalled();
});

it('does nothing without a wallet', async () => {
  mockGetWalletAddress.mockResolvedValue(null);

  await expect(checkForNewActivity()).resolves.toBe(0);
  expect(mockLoadActivity).not.toHaveBeenCalled();
});
