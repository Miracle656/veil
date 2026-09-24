import {
  clearPendingRoute,
  consumePendingRoute,
  hasPendingRoute,
  setPendingRoute,
} from '../pendingRoute';

describe('pendingRoute', () => {
  beforeEach(() => clearPendingRoute());

  it('hands the route back once and then forgets it', () => {
    setPendingRoute('/transactions');
    expect(consumePendingRoute()).toBe('/transactions');
    // Consuming twice would navigate a second time on the next unlock, landing
    // the user somewhere they did not ask to go.
    expect(consumePendingRoute()).toBeNull();
  });

  it('returns null when nothing is pending', () => {
    expect(consumePendingRoute()).toBeNull();
    expect(hasPendingRoute()).toBe(false);
  });

  it('keeps the newest intent when two taps arrive', () => {
    setPendingRoute('/transactions');
    setPendingRoute('/token/USDC');
    expect(consumePendingRoute()).toBe('/token/USDC');
  });

  it('can be dropped without navigating', () => {
    setPendingRoute('/transactions');
    clearPendingRoute();
    expect(hasPendingRoute()).toBe(false);
    expect(consumePendingRoute()).toBeNull();
  });

  /**
   * The bug this whole module exists for: a tap that foregrounds the app races
   * the auto-lock, which `replace`s to /lock and then sends the user to
   * /dashboard on unlock. Recording the destination instead of navigating means
   * the lock can happen in between and the destination still survives it.
   */
  it('survives a lock cycle between the tap and the navigation', () => {
    setPendingRoute('/transactions');

    // …app locks, user unlocks, router settles on /dashboard…

    expect(consumePendingRoute()).toBe('/transactions');
  });
});
