/**
 * Tests for the app-lock policy and the idle watcher it drives.
 *
 * `lib/appLock.ts` holds module-level state hydrated once from storage, so most
 * cases need a fresh module instance. `loadAppLock` handles that: reset the
 * registry, import, and wait for hydration — the same shape `theme.test.ts` uses.
 */

const mockStorage = new Map<string, string>();
let mockReadError: Error | null = null;

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => {
      if (mockReadError) throw mockReadError;
      return mockStorage.get(key) ?? null;
    }),
    setItem: jest.fn(async (key: string, value: string) => {
      mockStorage.set(key, value);
    }),
  },
}));

import type { AppStateStatus } from 'react-native';

type AppLockModule = typeof import('../appLock');

const TIMEOUT_KEY = 'veil_idle_lock_minutes';
const BIOMETRICS_KEY = 'veil_lock_require_biometrics';

const MINUTE = 60_000;

/** Import a fresh copy of lib/appLock.ts and wait for hydration to settle. */
async function loadAppLock(): Promise<AppLockModule> {
  jest.resetModules();
  const mod: AppLockModule = require('../appLock');
  await mod.hydrateLockSettings();
  return mod;
}

/** A controllable clock, so idle time can be advanced without waiting for it. */
function fakeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
      jest.advanceTimersByTime(ms);
    },
  };
}

/** A stand-in for React Native's AppState stream. */
function fakeAppState() {
  const listeners = new Set<(state: AppStateStatus) => void>();
  return {
    subscribe: (listener: (state: AppStateStatus) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (state: AppStateStatus) => {
      for (const listener of [...listeners]) listener(state);
    },
    listenerCount: () => listeners.size,
  };
}

beforeEach(() => {
  mockStorage.clear();
  mockReadError = null;
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('settings', () => {
  it('defaults to a 5-minute timeout with biometrics off', async () => {
    const appLock = await loadAppLock();

    expect(appLock.getLockSettings()).toEqual({ timeout: 5, requireBiometrics: false });
    expect(appLock.isLockSettingsHydrated()).toBe(true);
  });

  it('reads the timeout the web wallet stored under the shared key', async () => {
    mockStorage.set(TIMEOUT_KEY, '30');
    const appLock = await loadAppLock();

    expect(appLock.getLockSettings().timeout).toBe(30);
  });

  it('reads a persisted biometric requirement', async () => {
    mockStorage.set(BIOMETRICS_KEY, 'true');
    const appLock = await loadAppLock();

    expect(appLock.getLockSettings().requireBiometrics).toBe(true);
  });

  it('falls back to the default for an unusable stored timeout', async () => {
    for (const stored of ['0', '7', 'soon', '']) {
      mockStorage.set(TIMEOUT_KEY, stored);
      const appLock = await loadAppLock();
      expect(appLock.getLockSettings().timeout).toBe(5);
    }
  });

  it('falls back to the defaults when storage cannot be read at all', async () => {
    mockReadError = new Error('storage unavailable');
    const appLock = await loadAppLock();

    expect(appLock.getLockSettings()).toEqual({ timeout: 5, requireBiometrics: false });
    expect(appLock.isLockSettingsHydrated()).toBe(true);
  });

  it('persists and notifies on change', async () => {
    const appLock = await loadAppLock();
    const listener = jest.fn();
    appLock.subscribeToLockSettings(listener);

    await appLock.setLockTimeout(15);
    expect(appLock.getLockSettings().timeout).toBe(15);
    expect(mockStorage.get(TIMEOUT_KEY)).toBe('15');

    await appLock.setRequireBiometrics(true);
    expect(appLock.getLockSettings().requireBiometrics).toBe(true);
    expect(mockStorage.get(BIOMETRICS_KEY)).toBe('true');

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('keeps the other setting intact when one changes', async () => {
    const appLock = await loadAppLock();

    await appLock.setRequireBiometrics(true);
    await appLock.setLockTimeout('never');

    expect(appLock.getLockSettings()).toEqual({ timeout: 'never', requireBiometrics: true });
  });

  it('rejects a timeout that is not on offer', async () => {
    const appLock = await loadAppLock();

    await expect(appLock.setLockTimeout(7 as never)).rejects.toThrow('Unknown lock timeout');
    expect(appLock.getLockSettings().timeout).toBe(5);
  });

  it('converts timeouts to milliseconds, with never disabling auto-lock', async () => {
    const appLock = await loadAppLock();

    expect(appLock.lockTimeoutToMs(5)).toBe(5 * MINUTE);
    expect(appLock.lockTimeoutToMs(30)).toBe(30 * MINUTE);
    expect(appLock.lockTimeoutToMs('never')).toBeNull();
  });

  it('shares one storage read across concurrent hydrations', async () => {
    jest.resetModules();
    const appLock: AppLockModule = require('../appLock');
    const storage = require('@react-native-async-storage/async-storage').default;

    await Promise.all([
      appLock.hydrateLockSettings(),
      appLock.hydrateLockSettings(),
      appLock.hydrateLockSettings(),
    ]);

    // One read per key at import, and no more however many callers ask.
    expect(storage.getItem).toHaveBeenCalledTimes(2);
  });
});

describe('createIdleWatcher', () => {
  it('locks once the idle period elapses', async () => {
    const appLock = await loadAppLock();
    const clock = fakeClock();
    const onLock = jest.fn();

    const watcher = appLock.createIdleWatcher({ onLock, now: clock.now, subscribeToAppState: fakeAppState().subscribe });
    watcher.start();

    clock.advance(5 * MINUTE - 1);
    expect(onLock).not.toHaveBeenCalled();

    clock.advance(1);
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('restarts the countdown on activity', async () => {
    const appLock = await loadAppLock();
    const clock = fakeClock();
    const onLock = jest.fn();

    const watcher = appLock.createIdleWatcher({ onLock, now: clock.now, subscribeToAppState: fakeAppState().subscribe });
    watcher.start();

    clock.advance(4 * MINUTE);
    watcher.noteActivity();
    clock.advance(4 * MINUTE);
    expect(onLock).not.toHaveBeenCalled();

    clock.advance(MINUTE);
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('never locks when the timeout is set to never', async () => {
    mockStorage.set(TIMEOUT_KEY, 'never');
    const appLock = await loadAppLock();
    const clock = fakeClock();
    const onLock = jest.fn();

    const watcher = appLock.createIdleWatcher({ onLock, now: clock.now, subscribeToAppState: fakeAppState().subscribe });
    watcher.start();

    clock.advance(24 * 60 * MINUTE);
    expect(onLock).not.toHaveBeenCalled();
  });

  // ── The acceptance criterion: changing the timeout changes lock behaviour ────

  it('applies a longer timeout to the countdown already running', async () => {
    const appLock = await loadAppLock();
    const clock = fakeClock();
    const onLock = jest.fn();

    const watcher = appLock.createIdleWatcher({ onLock, now: clock.now, subscribeToAppState: fakeAppState().subscribe });
    watcher.start();

    clock.advance(4 * MINUTE);
    await appLock.setLockTimeout(30);

    // The 5-minute deadline would have passed here; the new one has not.
    clock.advance(2 * MINUTE);
    expect(onLock).not.toHaveBeenCalled();

    clock.advance(24 * MINUTE);
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('applies a shortened timeout to the countdown already running', async () => {
    mockStorage.set(TIMEOUT_KEY, '30');
    const appLock = await loadAppLock();
    const clock = fakeClock();
    const onLock = jest.fn();

    const watcher = appLock.createIdleWatcher({ onLock, now: clock.now, subscribeToAppState: fakeAppState().subscribe });
    watcher.start();

    clock.advance(6 * MINUTE);
    expect(onLock).not.toHaveBeenCalled();

    // Six minutes idle already exceeds the new five-minute policy, so the lock
    // is due immediately rather than at the old deadline.
    await appLock.setLockTimeout(5);
    jest.advanceTimersByTime(0);
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending lock when auto-lock is switched off', async () => {
    const appLock = await loadAppLock();
    const clock = fakeClock();
    const onLock = jest.fn();

    const watcher = appLock.createIdleWatcher({ onLock, now: clock.now, subscribeToAppState: fakeAppState().subscribe });
    watcher.start();

    clock.advance(4 * MINUTE);
    await appLock.setLockTimeout('never');
    clock.advance(60 * MINUTE);

    expect(onLock).not.toHaveBeenCalled();
  });

  // ── Backgrounding ───────────────────────────────────────────────────────────

  it('locks on return when the idle period elapsed in the background', async () => {
    const appLock = await loadAppLock();
    const clock = fakeClock();
    const appState = fakeAppState();
    const onLock = jest.fn();

    const watcher = appLock.createIdleWatcher({
      onLock,
      now: clock.now,
      subscribeToAppState: appState.subscribe,
    });
    watcher.start();

    appState.emit('background');
    // Timers are frozen while backgrounded, so only the clock moves.
    clock.advance(10 * MINUTE);
    expect(onLock).not.toHaveBeenCalled();

    appState.emit('active');
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('does not lock on return when the idle period has not elapsed', async () => {
    const appLock = await loadAppLock();
    const clock = fakeClock();
    const appState = fakeAppState();
    const onLock = jest.fn();

    const watcher = appLock.createIdleWatcher({
      onLock,
      now: clock.now,
      subscribeToAppState: appState.subscribe,
    });
    watcher.start();

    appState.emit('background');
    clock.advance(2 * MINUTE);
    appState.emit('active');
    expect(onLock).not.toHaveBeenCalled();

    // The countdown resumes from the original activity, not from the return.
    clock.advance(3 * MINUTE);
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('does not lock on return when auto-lock is off', async () => {
    mockStorage.set(TIMEOUT_KEY, 'never');
    const appLock = await loadAppLock();
    const clock = fakeClock();
    const appState = fakeAppState();
    const onLock = jest.fn();

    const watcher = appLock.createIdleWatcher({
      onLock,
      now: clock.now,
      subscribeToAppState: appState.subscribe,
    });
    watcher.start();

    appState.emit('background');
    clock.advance(24 * 60 * MINUTE);
    appState.emit('active');

    expect(onLock).not.toHaveBeenCalled();
  });

  // ── Deferral and teardown ───────────────────────────────────────────────────

  it('postpones a lock while a transaction is in flight', async () => {
    const appLock = await loadAppLock();
    const clock = fakeClock();
    const onLock = jest.fn();
    let busy = true;

    const watcher = appLock.createIdleWatcher({
      onLock,
      shouldDefer: () => busy,
      deferMs: 1_000,
      now: clock.now,
      subscribeToAppState: fakeAppState().subscribe,
    });
    watcher.start();

    clock.advance(5 * MINUTE);
    expect(onLock).not.toHaveBeenCalled();

    clock.advance(1_000);
    expect(onLock).not.toHaveBeenCalled();

    busy = false;
    clock.advance(1_000);
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('stops watching and unsubscribes on stop', async () => {
    const appLock = await loadAppLock();
    const clock = fakeClock();
    const appState = fakeAppState();
    const onLock = jest.fn();

    const watcher = appLock.createIdleWatcher({
      onLock,
      now: clock.now,
      subscribeToAppState: appState.subscribe,
    });
    watcher.start();
    expect(appState.listenerCount()).toBe(1);

    watcher.stop();
    expect(appState.listenerCount()).toBe(0);

    clock.advance(60 * MINUTE);
    await appLock.setLockTimeout(5);
    appState.emit('active');

    expect(onLock).not.toHaveBeenCalled();
  });

  it('ignores a repeated start rather than double-subscribing', async () => {
    const appLock = await loadAppLock();
    const appState = fakeAppState();

    const watcher = appLock.createIdleWatcher({
      onLock: jest.fn(),
      subscribeToAppState: appState.subscribe,
    });
    watcher.start();
    watcher.start();

    expect(appState.listenerCount()).toBe(1);
    watcher.stop();
  });
});
