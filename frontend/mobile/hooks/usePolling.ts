import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

/**
 * Calls `callback` every `intervalMs` while `enabled` AND the app is in the
 * foreground. The web dashboard keeps itself fresh with a service worker +
 * `setInterval`; React Native has no service worker, so a plain interval is the
 * whole story here.
 *
 * The latest `callback` is kept in a ref so the interval never restarts when
 * the callback identity changes (which it does every render) — the timer is
 * governed only by `intervalMs` and `enabled`, and is always cleared on unmount
 * or when polling is disabled.
 *
 * Backgrounded, the timer stops. What this drives is not cheap — the dashboard's
 * refresh is a balance read, a price lookup, a Soroban event scan and a Horizon
 * page — and running it every fifteen seconds behind a locked screen spends
 * battery and RPC quota on results nobody is looking at. A phone that has been
 * in a pocket for an hour would otherwise have made 240 rounds of it.
 *
 * Returning to the foreground fires the callback once immediately, before
 * resuming the interval, so the first thing the user sees is current rather
 * than up to `intervalMs` stale.
 */
export function usePolling(callback: () => void, intervalMs: number, enabled = true): void {
  const saved = useRef(callback);

  useEffect(() => {
    saved.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled) return;

    let id: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (id === null) id = setInterval(() => saved.current(), intervalMs);
    };
    const stop = () => {
      if (id !== null) {
        clearInterval(id);
        id = null;
      }
    };

    if (AppState.currentState === 'active') start();

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        // Catch up first, then resume the cadence.
        saved.current();
        start();
      } else {
        stop();
      }
    });

    return () => {
      stop();
      subscription.remove();
    };
  }, [intervalMs, enabled]);
}
