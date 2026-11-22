const mockFire = jest.fn();
const mockSave = jest.fn();

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));
jest.mock('expo-notifications', () => ({
  getLastNotificationResponseAsync: jest.fn().mockResolvedValue(null),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useSegments: () => ['dashboard'],
}));
jest.mock('../../lib/notifications', () => ({
  fireTransferNotification: (...args: unknown[]) => mockFire(...args),
  routeForNotificationResponse: jest.fn(() => null),
}));
jest.mock('../../lib/notifiedMovements', () => ({
  loadNotifiedMovements: jest.fn().mockResolvedValue(true),
  notifiedMovements: () => new Set<string>(),
  saveNotifiedMovements: () => mockSave(),
}));
jest.mock('../../lib/pendingRoute', () => ({
  consumePendingRoute: jest.fn(() => null),
  setPendingRoute: jest.fn(),
}));
jest.mock('../../lib/activityFeed', () => ({
  movementKey: (r: { hash?: string; id: string }) => r.hash ?? r.id,
  subscribeActivityFeed: jest.fn(() => jest.fn()),
}));

import { processNotificationSnapshot } from '../useNotifications';
import type { TxRecord } from '../../lib/activityFeed';

const tx = (overrides: Partial<TxRecord> = {}): TxRecord => ({
  id: 'op-1',
  type: 'received',
  amount: '5',
  asset: 'XLM',
  counterparty: 'GSENDER',
  timestamp: 1_700_000_000,
  hash: 'hash-1',
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockFire.mockResolvedValue(undefined);
  mockSave.mockResolvedValue(undefined);
});

it('suppresses foreground notifications for dust payments (any asset) and still marks them as seen', () => {
  const seen = new Set<string>(['seed-tx']);

  processNotificationSnapshot(
    [
      tx({ id: 'op-dust-xlm', hash: 'dust-xlm', amount: '0', asset: 'XLM', isDust: true }),
      tx({ id: 'op-dust-usdc', hash: 'dust-usdc', amount: '0', asset: 'USDC', isDust: true }),
    ],
    seen,
  );

  expect(mockFire).not.toHaveBeenCalled();
  expect(seen.has('dust-xlm')).toBe(true);
  expect(seen.has('dust-usdc')).toBe(true);
  expect(mockSave).toHaveBeenCalledTimes(1);

  // Re-emitting the same dust rows still never notifies
  processNotificationSnapshot(
    [tx({ id: 'op-dust-xlm', hash: 'dust-xlm', amount: '0', asset: 'XLM', isDust: true })],
    seen,
  );
  expect(mockFire).not.toHaveBeenCalled();
});

it('fires foreground notification for a real payment of 0.0001 or more', () => {
  const seen = new Set<string>(['seed-tx']);

  processNotificationSnapshot(
    [tx({ id: 'op-real', hash: 'real-1', amount: '0.0001', asset: 'USDC', isDust: false })],
    seen,
  );

  expect(mockFire).toHaveBeenCalledTimes(1);
  expect(mockFire).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'received',
      amount: '0.0001',
      asset: 'USDC',
      hash: 'real-1',
    }),
  );
  expect(seen.has('real-1')).toBe(true);
});
