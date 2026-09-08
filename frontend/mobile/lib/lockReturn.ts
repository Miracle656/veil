/**
 * Where the app was when it locked, so unlocking puts the user back there.
 *
 * The auto-lock `replace`s to `/lock`, which discards the route it was on;
 * unlocking then landed on the dashboard no matter what. Being thrown out of a
 * half-filled swap or cash-out because the screen dimmed is the kind of thing
 * that makes an app feel like it forgets you.
 *
 * Deliberately in memory only. A remembered route is a convenience for one
 * uninterrupted sitting, not state worth reviving after the process dies — a
 * cold start should begin at the beginning.
 *
 * Kept separate from `pendingRoute`, which serves notification taps. The two
 * can be set in the same few frames (a tap wakes the app, the lock fires), and
 * sharing one slot would let whichever landed second silently erase the other.
 * With two slots the lock restores the screen and the notification's
 * destination then opens over it, which is what both intents asked for.
 */

/** Routes that must never be returned to: entry points, and the lock itself. */
const NEVER_RETURN = ['/', '/lock', '/index'];

let lockedFrom: string | null = null;

/**
 * Record the route the lock is covering. Ignores entry routes, so a lock during
 * startup doesn't pin the user to the splash.
 */
export function rememberLockReturn(path: string | null | undefined): void {
  if (!path) return;
  if (NEVER_RETURN.includes(path)) return;
  if (path.startsWith('/onboarding')) return;
  lockedFrom = path;
}

/** Take the remembered route, if any. Returns it once and forgets it. */
export function takeLockReturn(): string | null {
  const path = lockedFrom;
  lockedFrom = null;
  return path;
}

/** Drop the remembered route without navigating — for signing out, or a reset. */
export function clearLockReturn(): void {
  lockedFrom = null;
}
