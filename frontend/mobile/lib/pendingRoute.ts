/**
 * A single route the app owes the user, held until it is able to go there.
 *
 * Tapping a notification is the case this exists for. The tap is usually what
 * brings the app back to the foreground, and three things then happen in the
 * same few frames: the response listener fires, the auto-lock decides the app
 * was away too long and `replace`s to `/lock`, and the router finishes
 * mounting. Navigating straight from the listener loses that race — the lock's
 * replace lands last and the destination is gone, which is why the tap looked
 * like it did nothing.
 *
 * So the listener records where it wanted to go, and whoever finds the app in a
 * state where it can navigate consumes it. Nothing here knows about
 * notifications specifically; anything with a destination and no way to reach
 * it yet can use it.
 */

let pending: string | null = null;

/** Record where the app should go once it can. A newer intent replaces an older one. */
export function setPendingRoute(route: string): void {
  pending = route;
}

/** Take the pending route, if any. Returns it once and forgets it. */
export function consumePendingRoute(): string | null {
  const route = pending;
  pending = null;
  return route;
}

/** Drop any pending route without navigating — for signing out, or a hard reset. */
export function clearPendingRoute(): void {
  pending = null;
}

/** Whether a destination is waiting. Exported for tests and diagnostics. */
export function hasPendingRoute(): boolean {
  return pending !== null;
}
