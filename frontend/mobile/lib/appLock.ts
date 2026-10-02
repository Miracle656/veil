/**
 * App-lock policy: how long the app may sit idle before it locks, and whether
 * unlocking requires biometrics.
 *
 * This is the settings half of the lock system — it decides *when* a lock is
 * due and *how strong* the unlock has to be. Presenting the lock screen and
 * performing the unlock is the other half (backlog #28), which consumes
 * {@link createIdleWatcher} and {@link getLockSettings} rather than reimplementing
 * either.
 *
 * Ported from the web wallet's `lib/idle-lock.ts`, with the parts that only
 * exist in a browser replaced:
 *
 *   - The web watches `mousemove` / `keydown` / `scroll` on `window`. React
 *     Native has no such global stream, so activity is reported explicitly via
 *     {@link IdleWatcher.noteActivity} and the countdown otherwise runs on a timer.
 *   - The web treats `visibilitychange` as activity. On a phone the equivalent
 *     event means something stronger: while backgrounded, JS timers are frozen
 *     or killed outright, so a timer alone would let a phone sit in a pocket for
 *     an hour and come back unlocked. The watcher therefore records when the app
 *     left the foreground and, on return, locks if the idle period already
 *     elapsed while it was away.
 *
 * The timeout is stored under the same key the web wallet uses, so a user who
 * chose "15 minutes" in the browser gets 15 minutes on their phone too.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';

// ── Settings ────────────────────────────────────────────────────────────────────

/** Idle period before the app locks, in minutes, or `'never'` to disable auto-lock. */
export type LockTimeout = 5 | 15 | 30 | 'never';

/**
 * Selectable timeouts. Deliberately the same four the web wallet offers: the
 * setting is shared across both clients, so an option that only exists on one
 * of them would be silently rewritten by the other.
 */
export const LOCK_TIMEOUT_OPTIONS: readonly LockTimeout[] = [5, 15, 30, 'never'];

/** Used until a stored preference is read, and for any unreadable value. */
export const DEFAULT_LOCK_TIMEOUT: LockTimeout = 5;

/**
 * Biometrics default to off. Requiring them is a real trade-off — a user whose
 * fingerprint sensor stops recognising them still has to get into their wallet —
 * so it is opted into, not out of.
 */
export const DEFAULT_REQUIRE_BIOMETRICS = false;

/** AsyncStorage key holding the idle timeout. Shared with the web wallet. */
export const LOCK_TIMEOUT_STORAGE_KEY = 'veil_idle_lock_minutes';

/** AsyncStorage key holding the biometric-unlock requirement. */
export const REQUIRE_BIOMETRICS_STORAGE_KEY = 'veil_lock_require_biometrics';

export type LockSettings = {
  /** Idle period before locking. */
  timeout: LockTimeout;
  /**
   * Whether unlocking must present a biometric factor.
   *
   * A preference, not a capability check: whether this device *has* usable
   * biometrics can change between now and the unlock, so the lock screen
   * resolves that at the moment it prompts.
   */
  requireBiometrics: boolean;
};

/** Narrow an arbitrary value to a selectable timeout. */
export function isLockTimeout(value: unknown): value is LockTimeout {
  return LOCK_TIMEOUT_OPTIONS.includes(value as LockTimeout);
}

/** A timeout in milliseconds, or null when auto-lock is disabled. */
export function lockTimeoutToMs(timeout: LockTimeout): number | null {
  return timeout === 'never' ? null : timeout * 60 * 1000;
}

/** Parse a stored timeout string back into an option, falling back to the default. */
function parseStoredTimeout(raw: string | null): LockTimeout {
  if (raw === 'never') return 'never';
  const minutes = Number(raw);
  return isLockTimeout(minutes) ? minutes : DEFAULT_LOCK_TIMEOUT;
}

// ── Active settings ─────────────────────────────────────────────────────────────

let settings: LockSettings = {
  timeout: DEFAULT_LOCK_TIMEOUT,
  requireBiometrics: DEFAULT_REQUIRE_BIOMETRICS,
};
let hydrated = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Subscribe to settings changes. Every live idle watcher subscribes, which is
 * what makes a timeout change take effect immediately rather than at the next
 * lock — the acceptance criterion for this setting.
 *
 * @returns An unsubscribe function.
 */
export function subscribeToLockSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The active settings. Cheap enough to call in a render. */
export function getLockSettings(): LockSettings {
  return settings;
}

/** Whether the stored preferences have been read yet. */
export function isLockSettingsHydrated(): boolean {
  return hydrated;
}

// ── Hydration ───────────────────────────────────────────────────────────────────

let hydration: Promise<LockSettings> | null = null;

/**
 * Load the stored preferences. Idempotent: repeated calls share one read, so
 * every mounted consumer can call it without extra storage hits.
 */
export function hydrateLockSettings(): Promise<LockSettings> {
  hydration ??= Promise.all([
    AsyncStorage.getItem(LOCK_TIMEOUT_STORAGE_KEY).catch(() => null),
    AsyncStorage.getItem(REQUIRE_BIOMETRICS_STORAGE_KEY).catch(() => null),
  ]).then(([storedTimeout, storedBiometrics]) => {
    settings = {
      timeout: parseStoredTimeout(storedTimeout),
      requireBiometrics: storedBiometrics === 'true',
    };
    hydrated = true;
    // Notify unconditionally: a watcher started before hydration needs to know
    // the policy has settled even when it settled on the defaults.
    notify();
    return settings;
  });
  return hydration;
}

// Start reading at import so the policy is usually in place before the first
// screen paints, and before any watcher schedules its first lock.
void hydrateLockSettings();

// ── Mutation ────────────────────────────────────────────────────────────────────

function update(next: LockSettings): void {
  settings = next;
  hydrated = true;
  hydration = Promise.resolve(next);
  notify();
}

/**
 * Set the idle timeout and persist it.
 *
 * Applied in memory first: subscribers — including any running watcher —
 * reschedule off the new value before the write completes, so the change is
 * immediate and a failed write costs the preference at next launch rather than
 * the behaviour now.
 */
export async function setLockTimeout(timeout: LockTimeout): Promise<void> {
  if (!isLockTimeout(timeout)) throw new Error(`Unknown lock timeout: ${String(timeout)}`);
  update({ ...settings, timeout });
  await AsyncStorage.setItem(LOCK_TIMEOUT_STORAGE_KEY, String(timeout));
}

/** Set whether unlocking requires biometrics, and persist it. */
export async function setRequireBiometrics(requireBiometrics: boolean): Promise<void> {
  update({ ...settings, requireBiometrics });
  await AsyncStorage.setItem(REQUIRE_BIOMETRICS_STORAGE_KEY, String(requireBiometrics));
}

// ── Idle watcher ────────────────────────────────────────────────────────────────

export type IdleWatcherOptions = {
  /** Called when the idle period elapses and locking is not deferred. */
  onLock: () => void;
  /** While this returns true, locking is postponed — e.g. an in-flight transaction. */
  shouldDefer?: () => boolean;
  /** How long to wait before re-checking a deferred lock. Defaults to 35s. */
  deferMs?: number;
  /** Clock source, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** AppState subscription source, injectable for tests. */
  subscribeToAppState?: (listener: (state: AppStateStatus) => void) => () => void;
};

export type IdleWatcher = {
  /** Begin watching. Safe to call twice. */
  start: () => void;
  /** Stop watching and cancel any pending lock. */
  stop: () => void;
  /** Report user activity, restarting the countdown. */
  noteActivity: () => void;
};

/** Matches the web wallet's re-check interval for a deferred lock. */
const DEFAULT_DEFER_MS = 35_000;

function defaultAppStateSubscription(listener: (state: AppStateStatus) => void): () => void {
  const subscription: NativeEventSubscription = AppState.addEventListener('change', listener);
  return () => subscription.remove();
}

/**
 * Create an idle watcher driven by the current lock settings.
 *
 * Backlog #28 wires this to the lock screen; nothing else in the app needs to
 * know how the policy is stored or when it changes.
 */
export function createIdleWatcher(options: IdleWatcherOptions): IdleWatcher {
  const now = options.now ?? Date.now;
  const deferMs = options.deferMs ?? DEFAULT_DEFER_MS;
  const subscribeToAppState = options.subscribeToAppState ?? defaultAppStateSubscription;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastActivityAt = now();
  let started = false;
  let unsubscribeSettings: (() => void) | null = null;
  let unsubscribeAppState: (() => void) | null = null;

  function clear(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function fire(): void {
    timer = null;
    // Never interrupt an in-flight transaction. Re-check instead of locking.
    if (options.shouldDefer?.()) {
      timer = setTimeout(fire, deferMs);
      return;
    }
    options.onLock();
  }

  /** (Re)arm the countdown for whatever remains of the idle period. */
  function schedule(): void {
    clear();
    if (!started) return;

    const timeoutMs = lockTimeoutToMs(getLockSettings().timeout);
    if (timeoutMs === null) return; // 'never' — auto-lock disabled

    const remaining = lastActivityAt + timeoutMs - now();
    // A shortened timeout can leave the deadline already in the past. Fire on
    // the next tick rather than synchronously, so a caller changing the setting
    // is not re-entered from inside its own state update.
    timer = setTimeout(fire, Math.max(0, remaining));
  }

  function noteActivity(): void {
    lastActivityAt = now();
    schedule();
  }

  function handleAppState(state: AppStateStatus): void {
    if (state === 'active') {
      const timeoutMs = lockTimeoutToMs(getLockSettings().timeout);
      // Timers do not run reliably in the background, so returning to the
      // foreground is where a lock that came due while away is discovered.
      if (timeoutMs !== null && now() - lastActivityAt >= timeoutMs) {
        clear();
        fire();
        return;
      }
      schedule();
      return;
    }

    // Leaving the foreground is not activity: the countdown keeps running from
    // whenever the user last actually did something.
    clear();
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      lastActivityAt = now();
      // A timeout change must take effect now, not at the next lock.
      unsubscribeSettings = subscribeToLockSettings(schedule);
      unsubscribeAppState = subscribeToAppState(handleAppState);
      schedule();
    },

    stop(): void {
      if (!started) return;
      started = false;
      clear();
      unsubscribeSettings?.();
      unsubscribeSettings = null;
      unsubscribeAppState?.();
      unsubscribeAppState = null;
    },

    noteActivity,
  };
}
