import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  MAX_ATTEMPTS,
  __resetOutboxForTests,
  clearOutbox,
  enqueueOutboxAction,
  flushOutbox,
  getOutbox,
  hydrateOutbox,
  registerOutboxHandler,
  removeOutboxAction,
  subscribeOutbox,
} from '../outbox';

// async-storage 3.x no longer ships `jest/async-storage-mock`, so this is the
// same in-memory stand-in the other mobile suites use.
const mockStorage = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      mockStorage.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      mockStorage.delete(key);
    }),
    clear: jest.fn(async () => {
      mockStorage.clear();
    }),
  },
}));

const STORAGE_KEY = 'veil_outbox_v1';

beforeEach(async () => {
  __resetOutboxForTests();
  await AsyncStorage.clear();
  jest.clearAllMocks();
});

describe('enqueueOutboxAction', () => {
  it('appends actions in order and persists them', async () => {
    await enqueueOutboxAction('payment', { amount: '1' });
    await enqueueOutboxAction('payment', { amount: '2' });

    expect(getOutbox().map((action) => action.payload)).toEqual([
      { amount: '1' },
      { amount: '2' },
    ]);

    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    expect(JSON.parse(raw as string)).toHaveLength(2);
  });

  it('gives each action a distinct id', async () => {
    const first = await enqueueOutboxAction('payment', {});
    const second = await enqueueOutboxAction('payment', {});
    expect(first.id).not.toEqual(second.id);
  });

  it('notifies subscribers', async () => {
    const listener = jest.fn();
    subscribeOutbox(listener);
    expect(listener).toHaveBeenCalledWith([]);

    await enqueueOutboxAction('payment', {});
    expect(listener).toHaveBeenLastCalledWith([expect.objectContaining({ type: 'payment' })]);
  });
});

describe('hydrateOutbox', () => {
  it('restores a queue persisted by a previous session', async () => {
    await AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ id: 'a', type: 'payment', payload: { amount: '5' }, createdAt: 1, attempts: 0 }])
    );

    const restored = await hydrateOutbox();
    expect(restored).toHaveLength(1);
    expect(restored[0].payload).toEqual({ amount: '5' });
  });

  it('discards malformed entries instead of throwing', async () => {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([{ nope: true }, 'garbage']));
    expect(await hydrateOutbox()).toEqual([]);
  });

  it('recovers from unparseable storage', async () => {
    await AsyncStorage.setItem(STORAGE_KEY, '{not json');
    expect(await hydrateOutbox()).toEqual([]);
  });
});

describe('flushOutbox', () => {
  it('runs queued actions in FIFO order and empties the queue', async () => {
    const seen: unknown[] = [];
    registerOutboxHandler('payment', async (payload) => {
      seen.push(payload);
    });

    await enqueueOutboxAction('payment', { amount: '1' });
    await enqueueOutboxAction('payment', { amount: '2' });

    const summary = await flushOutbox();

    expect(seen).toEqual([{ amount: '1' }, { amount: '2' }]);
    expect(summary).toEqual({ succeeded: 2, retried: 0, dropped: 0 });
    expect(getOutbox()).toEqual([]);
  });

  it('keeps failing actions queued with the attempt count bumped', async () => {
    registerOutboxHandler('payment', async () => {
      throw new Error('network unreachable');
    });
    await enqueueOutboxAction('payment', { amount: '1' });

    const summary = await flushOutbox();

    expect(summary).toEqual({ succeeded: 0, retried: 1, dropped: 0 });
    expect(getOutbox()[0].attempts).toBe(1);
    expect(getOutbox()[0].lastError).toBe('network unreachable');
  });

  it('drops an action once it exceeds the retry ceiling', async () => {
    registerOutboxHandler('payment', async () => {
      throw new Error('still failing');
    });
    await enqueueOutboxAction('payment', {});

    for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) {
      await flushOutbox();
      expect(getOutbox()).toHaveLength(1);
    }

    expect(await flushOutbox()).toEqual({ succeeded: 0, retried: 0, dropped: 1 });
    expect(getOutbox()).toEqual([]);
  });

  it('drops actions that have no registered handler', async () => {
    await enqueueOutboxAction('unknown-type', {});
    expect(await flushOutbox()).toEqual({ succeeded: 0, retried: 0, dropped: 1 });
    expect(getOutbox()).toEqual([]);
  });

  it('does not lose actions enqueued while a flush is in progress', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    registerOutboxHandler('slow', async () => {
      markStarted?.();
      await gate;
    });
    registerOutboxHandler('fast', async () => {});

    await enqueueOutboxAction('slow', { n: 1 });
    const flushing = flushOutbox();

    // Only enqueue once the flush has taken its snapshot of the queue.
    await started;
    await enqueueOutboxAction('fast', { n: 2 });
    release?.();
    await flushing;

    expect(getOutbox()).toEqual([expect.objectContaining({ type: 'fast' })]);
  });

  it('collapses a concurrent flush rather than double-sending', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = jest.fn(async () => {
      await gate;
    });
    registerOutboxHandler('payment', handler);
    await enqueueOutboxAction('payment', {});

    const first = flushOutbox();
    const second = await flushOutbox();

    expect(second).toEqual({ succeeded: 0, retried: 0, dropped: 0 });
    release?.();
    await first;
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('queue management', () => {
  it('removes a single action by id', async () => {
    const first = await enqueueOutboxAction('payment', { amount: '1' });
    await enqueueOutboxAction('payment', { amount: '2' });

    await removeOutboxAction(first.id);

    expect(getOutbox()).toHaveLength(1);
    expect(getOutbox()[0].payload).toEqual({ amount: '2' });
  });

  it('clears the whole queue', async () => {
    await enqueueOutboxAction('payment', {});
    await clearOutbox();
    expect(getOutbox()).toEqual([]);
    expect(JSON.parse((await AsyncStorage.getItem(STORAGE_KEY)) as string)).toEqual([]);
  });

  it('stops notifying after unsubscribe', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeOutbox(listener);
    unsubscribe();
    await enqueueOutboxAction('payment', {});
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
