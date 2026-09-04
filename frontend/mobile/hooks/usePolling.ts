import { useEffect, useRef } from 'react';

/**
 * Calls `callback` every `intervalMs` while `enabled`. The web dashboard keeps
 * itself fresh with a service worker + `setInterval`; React Native has no
 * service worker, so a plain interval is the whole story here.
 *
 * The latest `callback` is kept in a ref so the interval never restarts when
 * the callback identity changes (which it does every render) — the timer is
 * governed only by `intervalMs` and `enabled`, and is always cleared on
 * unmount or when polling is disabled.
 */
export function usePolling(callback: () => void, intervalMs: number, enabled = true): void {
  const saved = useRef(callback);

  useEffect(() => {
    saved.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => saved.current(), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
}
