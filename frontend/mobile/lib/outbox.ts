import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Offline outbox — a durable, FIFO queue of user actions that could not run
 * because the device was offline.
 *
 * Screens enqueue an action instead of failing; the connectivity provider
 * flushes the queue as soon as the device is back online. Handlers are
 * registered by feature code so this module stays free of wallet/network
 * concerns and remains unit-testable on its own.
 */

const STORAGE_KEY = 'veil_outbox_v1';

/** Give up on an action after this many failed flush attempts. */
export const MAX_ATTEMPTS = 5;

export type OutboxAction = {
  /** Stable id, unique for the lifetime of the queue entry. */
  id: string;
  /** Handler key — see {@link registerOutboxHandler}. */
  type: string;
  payload: unknown;
  /** Unix ms at which the action was queued. */
  createdAt: number;
  /** Number of flush attempts made so far. */
  attempts: number;
  /** Message from the most recent failed attempt, when there was one. */
  lastError?: string;
};

export type OutboxHandler = (payload: unknown, action: OutboxAction) => Promise<void>;

export type FlushSummary = {
  /** Actions that ran successfully and left the queue. */
  succeeded: number;
  /** Actions that failed but remain queued for a later flush. */
  retried: number;
  /** Actions dropped after exceeding {@link MAX_ATTEMPTS}. */
  dropped: number;
};

type OutboxListener = (queue: OutboxAction[]) => void;

let queue: OutboxAction[] = [];
let hydrated = false;
let flushing = false;

const listeners = new Set<OutboxListener>();
const handlers = new Map<string, OutboxHandler>();

function notify(): void {
  const snapshot = getOutbox();
  for (const listener of listeners) listener(snapshot);
}

async function persist(): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch (error) {
    console.warn('[outbox] failed to persist queue', error);
  }
}

function isOutboxAction(value: unknown): value is OutboxAction {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<OutboxAction>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.type === 'string' &&
    typeof candidate.createdAt === 'number' &&
    typeof candidate.attempts === 'number'
  );
}

function nextId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Load the persisted queue into memory. Safe to call repeatedly — only the
 * first call touches storage.
 */
export async function hydrateOutbox(): Promise<OutboxAction[]> {
  if (hydrated) return getOutbox();
  hydrated = true;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      queue = Array.isArray(parsed) ? parsed.filter(isOutboxAction) : [];
    }
  } catch (error) {
    console.warn('[outbox] failed to read persisted queue', error);
    queue = [];
  }
  notify();
  return getOutbox();
}

/** Register the handler that runs actions of `type` when the queue flushes. */
export function registerOutboxHandler(type: string, handler: OutboxHandler): () => void {
  handlers.set(type, handler);
  return () => {
    if (handlers.get(type) === handler) handlers.delete(type);
  };
}

/** Queue an action to run the next time the device is online. */
export async function enqueueOutboxAction(type: string, payload: unknown): Promise<OutboxAction> {
  const action: OutboxAction = {
    id: nextId(),
    type,
    payload,
    createdAt: Date.now(),
    attempts: 0,
  };
  queue = [...queue, action];
  notify();
  await persist();
  return action;
}

/** Remove a single queued action, e.g. when the user cancels it. */
export async function removeOutboxAction(id: string): Promise<void> {
  const next = queue.filter((action) => action.id !== id);
  if (next.length === queue.length) return;
  queue = next;
  notify();
  await persist();
}

/** Drop every queued action without running it. */
export async function clearOutbox(): Promise<void> {
  if (queue.length === 0) return;
  queue = [];
  notify();
  await persist();
}

/** Current queue contents, oldest first. */
export function getOutbox(): OutboxAction[] {
  return [...queue];
}

export function subscribeOutbox(listener: OutboxListener): () => void {
  listeners.add(listener);
  listener(getOutbox());
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Run every queued action in order.
 *
 * Actions run one at a time so ordering is preserved — a payment queued before
 * another still settles first. A failing action stays queued (with its attempt
 * count bumped) until it exceeds {@link MAX_ATTEMPTS}, at which point it is
 * dropped so a permanently broken action cannot wedge the queue. Actions with
 * no registered handler are also dropped, since nothing can ever run them.
 *
 * Concurrent calls are collapsed: if a flush is already running this returns an
 * empty summary rather than double-sending.
 */
export async function flushOutbox(): Promise<FlushSummary> {
  const summary: FlushSummary = { succeeded: 0, retried: 0, dropped: 0 };
  // Claim the flush synchronously — an `await` before this check would let a
  // second caller slip through and send everything twice.
  if (flushing) return summary;
  flushing = true;

  try {
    await hydrateOutbox();
    if (queue.length === 0) return summary;

    const pending = getOutbox();
    const remaining: OutboxAction[] = [];

    for (const action of pending) {
      const handler = handlers.get(action.type);
      if (!handler) {
        console.warn(`[outbox] dropping action with no registered handler: ${action.type}`);
        summary.dropped += 1;
        continue;
      }

      try {
        await handler(action.payload, action);
        summary.succeeded += 1;
      } catch (error) {
        const attempts = action.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          summary.dropped += 1;
          continue;
        }
        remaining.push({
          ...action,
          attempts,
          lastError: error instanceof Error ? error.message : String(error),
        });
        summary.retried += 1;
      }
    }

    // Anything enqueued while the flush was running is appended after the
    // retries so ordering still reflects when each action was created.
    const enqueuedDuringFlush = queue.filter(
      (action) => !pending.some((item) => item.id === action.id)
    );
    queue = [...remaining, ...enqueuedDuringFlush];
    notify();
    await persist();
  } finally {
    flushing = false;
  }

  return summary;
}

/** Test-only: reset all module state. */
export function __resetOutboxForTests(): void {
  queue = [];
  hydrated = false;
  flushing = false;
  listeners.clear();
  handlers.clear();
}
