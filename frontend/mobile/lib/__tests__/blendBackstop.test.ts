/**
 * Blend backstop withdrawal queue unit tests.
 *
 * Covers the queued state, the matured state, cancellation state transitions,
 * absolute date formatting (never day counts), exit-terms copy, SDK loading,
 * and maturity notification scheduling / cancellation.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  applyWithdrawalCancellation,
  BACKSTOP_CANCEL_COPY,
  BACKSTOP_EXIT_TERMS,
  BACKSTOP_QUEUE_DAYS,
  BACKSTOP_QUEUE_SECONDS,
  BACKSTOP_QUEUED_FACTS,
  computeMaturityTimestamp,
  formatAvailableDate,
  formatMaturedDate,
  getQueueStatus,
  loadBackstopPositions,
  type BackstopPosition,
} from '../blendBackstop';
import {
  BACKSTOP_NOTIFICATION_ROUTE,
  cancelBackstopMaturityNotification,
  scheduleBackstopMaturityNotification,
} from '../notifications';

jest.mock('@stellar/stellar-sdk', () => ({
  Networks: {
    TESTNET: 'Test SDF Network ; September 2015',
    PUBLIC: 'Public Global Stellar Network ; September 2015',
  },
  Account: class {},
  BASE_FEE: '100',
  TransactionBuilder: class {},
  xdr: { Operation: { fromXDR: () => ({}) } },
  rpc: {
    Server: class {},
    Api: { isSimulationError: () => false },
    assembleTransaction: () => ({}),
  },
}));

const mockMetaLoad = jest.fn();
const mockBackstopPoolV2Load = jest.fn();
const mockBackstopPoolV1Load = jest.fn();
const mockBackstopUserLoad = jest.fn();

jest.mock('@blend-capital/blend-sdk', () => ({
  PoolMetadata: { load: (...args: unknown[]) => mockMetaLoad(...args) },
  BackstopPoolV2: { load: (...args: unknown[]) => mockBackstopPoolV2Load(...args) },
  BackstopPoolV1: { load: (...args: unknown[]) => mockBackstopPoolV1Load(...args) },
  BackstopPoolUser: { load: (...args: unknown[]) => mockBackstopUserLoad(...args) },
  BackstopContractV1: class {},
  BackstopContractV2: class {},
}));

const mockScheduleNotification = jest.fn();
const mockCancelScheduledNotification = jest.fn();

jest.mock('expo-notifications', () => ({
  SchedulableTriggerInputTypes: { DATE: 'date', TIME_INTERVAL: 'timeInterval' },
  scheduleNotificationAsync: (...args: unknown[]) => mockScheduleNotification(...args),
  cancelScheduledNotificationAsync: (...args: unknown[]) => mockCancelScheduledNotification(...args),
  getLastNotificationResponseAsync: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(),
}));

const NOV_2_2026 = Math.floor(Date.UTC(2026, 10, 2, 12, 0, 0) / 1_000);
const NOV_19_2026 = Math.floor(Date.UTC(2026, 10, 19, 12, 0, 0) / 1_000);
const DEC_20_2026 = Math.floor(Date.UTC(2026, 11, 20, 12, 0, 0) / 1_000);
const JAN_6_2027 = Math.floor(Date.UTC(2027, 0, 6, 12, 0, 0) / 1_000);

describe('blendBackstop', () => {
  const originalPoolIds = process.env.EXPO_PUBLIC_BLEND_POOL_IDS;

  beforeEach(async () => {
    mockMetaLoad.mockReset();
    mockBackstopPoolV2Load.mockReset();
    mockBackstopPoolV1Load.mockReset();
    mockBackstopUserLoad.mockReset();
    mockScheduleNotification.mockReset();
    mockCancelScheduledNotification.mockReset().mockResolvedValue(undefined);
    await AsyncStorage.clear();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalPoolIds === undefined) delete process.env.EXPO_PUBLIC_BLEND_POOL_IDS;
    else process.env.EXPO_PUBLIC_BLEND_POOL_IDS = originalPoolIds;
  });

  describe('queue timing and absolute date formatting', () => {
    it('computes maturity exactly 17 days after queuing', () => {
      expect(BACKSTOP_QUEUE_DAYS).toBe(17);
      expect(BACKSTOP_QUEUE_SECONDS).toBe(17 * 86_400);
      expect(computeMaturityTimestamp(NOV_2_2026)).toBe(NOV_19_2026);
    });

    it('formats a queued withdrawal as an absolute date, never a day count', () => {
      const label = formatAvailableDate(NOV_19_2026, NOV_2_2026);
      expect(label).toBe('Available 19 November');
      expect(label.toLowerCase()).not.toContain('days');
      expect(label.toLowerCase()).not.toContain('remaining');
    });

    it('includes the year when the maturity date crosses into the next year', () => {
      expect(formatAvailableDate(JAN_6_2027, DEC_20_2026)).toBe('Available 6 January 2027');
    });

    it('formats a matured withdrawal with an absolute date', () => {
      expect(formatMaturedDate(NOV_19_2026, NOV_19_2026 + 3_600)).toBe('Available since 19 November');
    });

    it('distinguishes queued vs matured states around the maturity boundary', () => {
      expect(getQueueStatus({ availableAt: NOV_19_2026 }, NOV_2_2026)).toBe('queued');
      expect(getQueueStatus({ availableAt: NOV_19_2026 }, NOV_19_2026 - 1)).toBe('queued');
      expect(getQueueStatus({ availableAt: NOV_19_2026 }, NOV_19_2026)).toBe('matured');
      expect(getQueueStatus({ availableAt: NOV_19_2026 }, NOV_19_2026 + 86_400)).toBe('matured');
    });
  });

  describe('exit terms and queued copy', () => {
    it('states the 17-day protocol rule and bad-debt reason without calling it locked savings', () => {
      const combined = `${BACKSTOP_EXIT_TERMS.heading} ${BACKSTOP_EXIT_TERMS.summary} ${BACKSTOP_EXIT_TERMS.queueDetail}`;
      expect(combined).toContain('17 days');
      expect(combined).toContain('Blend protocol');
      expect(combined).toContain('not a Veil policy');
      expect(combined.toLowerCase()).toContain('bad debt');
      expect(combined.toLowerCase()).not.toContain('locked savings');
    });

    it('states both emissions-stopped and pool-interest-continues facts', () => {
      expect(BACKSTOP_QUEUED_FACTS.emissionsStopped.toLowerCase()).toContain('emissions');
      expect(BACKSTOP_QUEUED_FACTS.emissionsStopped.toLowerCase()).toContain('stopped');
      expect(BACKSTOP_QUEUED_FACTS.interestContinues.toLowerCase()).toContain('pool interest');
      expect(BACKSTOP_QUEUED_FACTS.interestContinues.toLowerCase()).toContain('continues');
    });

    it('frames cancellation as reversible', () => {
      expect(BACKSTOP_CANCEL_COPY.actionLabel.toLowerCase()).toContain('cancel');
      expect(BACKSTOP_CANCEL_COPY.helper.toLowerCase()).toContain('emissions resume');
    });
  });

  describe('applyWithdrawalCancellation', () => {
    const basePosition: BackstopPosition = {
      poolId: 'CPOOL1',
      poolName: 'Fixed',
      backstopId: 'CBACKSTOP1',
      shares: '100000000',
      tokens: '120000000',
      unlockedShares: '0',
      queuedWithdrawals: [
        {
          id: 'CPOOL1:1795089600:0',
          poolId: 'CPOOL1',
          poolName: 'Fixed',
          backstopId: 'CBACKSTOP1',
          shares: '50000000',
          tokens: '60000000',
          availableAt: NOV_19_2026,
        },
      ],
    };

    it('returns cancelled shares and tokens to the active position and clears the queue entry', () => {
      const next = applyWithdrawalCancellation(basePosition, 'CPOOL1:1795089600:0');
      expect(next.shares).toBe('150000000');
      expect(next.tokens).toBe('180000000');
      expect(next.queuedWithdrawals).toEqual([]);
    });

    it('is a no-op when the withdrawal id does not exist', () => {
      const next = applyWithdrawalCancellation(basePosition, 'missing');
      expect(next).toEqual(basePosition);
    });
  });

  describe('loadBackstopPositions', () => {
    it('loads active shares, queued entries, and matured unlocked entries', async () => {
      process.env.EXPO_PUBLIC_BLEND_POOL_IDS = 'CPOOL1';
      mockMetaLoad.mockResolvedValue({ name: 'Fixed', backstop: 'CBACKSTOP1' });
      mockBackstopPoolV2Load.mockResolvedValue({
        sharesToBackstopTokens: (shares: bigint) => shares * 2n,
      });
      mockBackstopUserLoad.mockResolvedValue({
        balance: {
          shares: 100n,
          unlockedQ4W: 40n,
          q4w: [{ amount: 50n, exp: BigInt(NOV_19_2026) }],
        },
      });

      const positions = await loadBackstopPositions('GUSER', NOV_2_2026);

      expect(positions).toHaveLength(1);
      expect(positions[0].shares).toBe('100');
      expect(positions[0].tokens).toBe('200');
      expect(positions[0].unlockedShares).toBe('40');
      expect(positions[0].queuedWithdrawals).toHaveLength(2);
      expect(getQueueStatus(positions[0].queuedWithdrawals[0], NOV_2_2026)).toBe('matured');
      expect(getQueueStatus(positions[0].queuedWithdrawals[1], NOV_2_2026)).toBe('queued');
      expect(positions[0].queuedWithdrawals[1].availableAt).toBe(NOV_19_2026);
    });

    it('returns an empty list when backstop loading fails', async () => {
      process.env.EXPO_PUBLIC_BLEND_POOL_IDS = 'CPOOL1';
      mockMetaLoad.mockRejectedValue(new Error('rpc down'));

      await expect(loadBackstopPositions('GUSER', NOV_2_2026)).resolves.toEqual([]);
    });
  });

  describe('maturity notifications', () => {
    it('schedules a maturity notification at the exact availableAt timestamp and routes to Earn', async () => {
      mockScheduleNotification.mockResolvedValue('notif-123');

      const id = await scheduleBackstopMaturityNotification({
        poolId: 'CPOOL1',
        poolName: 'Fixed',
        availableAt: NOV_19_2026,
        nowSeconds: NOV_2_2026,
      });

      expect(id).toBe('notif-123');
      expect(mockScheduleNotification).toHaveBeenCalledTimes(1);
      const call = mockScheduleNotification.mock.calls[0][0];
      expect(call.content.data.route).toBe(BACKSTOP_NOTIFICATION_ROUTE);
      expect(call.content.data.type).toBe('backstop-matured');
      expect(call.trigger.date).toEqual(new Date(NOV_19_2026 * 1_000));
    });

    it('does not schedule a notification for an already matured withdrawal', async () => {
      const id = await scheduleBackstopMaturityNotification({
        poolId: 'CPOOL1',
        poolName: 'Fixed',
        availableAt: NOV_2_2026,
        nowSeconds: NOV_19_2026,
      });

      expect(id).toBeNull();
      expect(mockScheduleNotification).not.toHaveBeenCalled();
    });

    it('cancels the scheduled maturity notification when the withdrawal is cancelled', async () => {
      mockScheduleNotification.mockResolvedValue('notif-456');

      await scheduleBackstopMaturityNotification({
        poolId: 'CPOOL1',
        poolName: 'Fixed',
        availableAt: NOV_19_2026,
        nowSeconds: NOV_2_2026,
      });

      await cancelBackstopMaturityNotification('CPOOL1', NOV_19_2026);

      expect(mockCancelScheduledNotification).toHaveBeenCalledWith('notif-456');
    });
  });
});
