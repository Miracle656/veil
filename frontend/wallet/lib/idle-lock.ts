// Inactive-session auto-lock.
//
// A framework-agnostic idle watcher: it listens for user activity
// (mouse/keyboard/touch/scroll) and visibility changes, and fires `onLock` after
// a configurable idle timeout. The timeout is persisted in localStorage and can
// be changed at runtime (5 / 15 / 30 minutes, or never).

export type IdleTimeout = 5 | 15 | 30 | 'never'

export const IDLE_TIMEOUT_OPTIONS: readonly IdleTimeout[] = [5, 15, 30, 'never']
export const DEFAULT_IDLE_TIMEOUT: IdleTimeout = 5

const STORAGE_KEY = 'veil_idle_lock_minutes'

/** Dispatched on `window` when the configured timeout changes, so live watchers reconfigure. */
export const IDLE_TIMEOUT_CHANGED_EVENT = 'veil:idle-timeout-changed'

const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'touchstart', 'click', 'scroll'] as const
const DEFAULT_DEFER_MS = 35_000

/** Convert a timeout option to milliseconds, or null when auto-lock is disabled ('never'). */
export function idleTimeoutToMs(timeout: IdleTimeout): number | null {
  return timeout === 'never' ? null : timeout * 60 * 1000
}

/** Read the configured idle timeout, falling back to the default for missing/invalid values. */
export function getIdleTimeout(): IdleTimeout {
  if (typeof window === 'undefined') return DEFAULT_IDLE_TIMEOUT
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (raw === 'never') return 'never'
  const minutes = Number(raw)
  if (minutes === 5 || minutes === 15 || minutes === 30) return minutes
  return DEFAULT_IDLE_TIMEOUT
}

/** Persist the idle timeout and notify any live watchers to apply it immediately. */
export function setIdleTimeout(timeout: IdleTimeout): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, String(timeout))
  window.dispatchEvent(new CustomEvent(IDLE_TIMEOUT_CHANGED_EVENT))
}

export type IdleWatcherOptions = {
  /** Called when the idle timeout elapses (and `shouldDefer` does not hold). */
  onLock: () => void
  /** When it returns true, locking is postponed (e.g. an in-flight transaction). */
  shouldDefer?: () => boolean
  /** How long to wait before re-checking when locking is deferred. Defaults to 35s. */
  deferMs?: number
  /** Current timeout in ms, or null to disable. Defaults to the persisted setting. */
  getTimeoutMs?: () => number | null
}

export type IdleWatcher = {
  start: () => void
  stop: () => void
  reset: () => void
}

/**
 * Create an idle watcher. Call `start()` to begin listening and `stop()` to tear
 * down. A user-activity event, a `visibilitychange`, or a timeout-config change
 * all reset the countdown.
 */
export function createIdleWatcher(options: IdleWatcherOptions): IdleWatcher {
  const getTimeoutMs = options.getTimeoutMs ?? (() => idleTimeoutToMs(getIdleTimeout()))
  const deferMs = options.deferMs ?? DEFAULT_DEFER_MS

  let timer: ReturnType<typeof setTimeout> | null = null
  let started = false

  function clear(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function fire(): void {
    timer = null
    // Never interrupt an in-flight transaction — reschedule and check again.
    if (options.shouldDefer?.()) {
      timer = setTimeout(fire, deferMs)
      return
    }
    options.onLock()
  }

  function reset(): void {
    clear()
    const ms = getTimeoutMs()
    if (ms === null || ms <= 0) return // 'never' → auto-lock disabled
    timer = setTimeout(fire, ms)
  }

  function start(): void {
    if (started || typeof window === 'undefined') return
    started = true
    ACTIVITY_EVENTS.forEach((event) => window.addEventListener(event, reset, { passive: true }))
    // Acceptance criterion: a visibility change resets the idle timer.
    document.addEventListener('visibilitychange', reset)
    window.addEventListener(IDLE_TIMEOUT_CHANGED_EVENT, reset)
    reset()
  }

  function stop(): void {
    if (!started) return
    started = false
    clear()
    ACTIVITY_EVENTS.forEach((event) => window.removeEventListener(event, reset))
    document.removeEventListener('visibilitychange', reset)
    window.removeEventListener(IDLE_TIMEOUT_CHANGED_EVENT, reset)
  }

  return { start, stop, reset }
}
