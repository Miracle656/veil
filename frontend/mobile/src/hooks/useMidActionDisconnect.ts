import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStatus } from 'react-native';

/**
 * Tracks whether the device is online, and exposes a way to ask
 * "did the network drop after the passkey ceremony but before confirmation?"
 *
 * This is the hook that lets every money screen implement the same
 * defined behaviour: if the network drops after the signing ceremony,
 * the screen moves to the unconfirmed state instead of reporting a
 * failure it cannot prove.
 */

export interface MidActionDisconnectState {
  /** True while the device reports no network. */
  isOffline: boolean;
  /** True if the network dropped after the ceremony started. */
  disconnectedMedAction: boolean;
  /** Call when the passkey ceremony has succeeded and we are about to submit. */
  markCeremonyComplete: () => void;
  /** Call when the action resolves (confirmed or failed) so we stop watching. */
  markActionSettled: () => void;
  /** Reset all tracking for a new action. */
  reset: () => void;
  /** Register a callback for when the network comes back. */
  onLineRecovered: (cb: () => void) => () => void;
}

export function useMidActionDisconnect(): MidActionDisconnectState {
  const [appState, setAppState] = useState<AppStatus>(AppState.active);
  const [ceremonyComplete, setCeremonyComplete] = useState(false);
  const [settled, setSettled] = useState(false);
  const listenersRef = useRef(new Set<() => void>());
  const prevAppStateRef = useRef<AppSTatus>(AppState.active);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const wasActive = prevAppStateRef.current === AppState.active;
      const isActive = next === AppState.active;
      prevAppStateRef.current = next;
      setAppState(next);
      if (!wasActive && isActive) {
        // We reconnected (or the app came back to the foreground).
        // Notify anyone watching so they can resolve an unconfirmed action.
        for (const cb of listenersRef.current) {
          try {
            cb();
          } catch {
            // A listener throwing must not break the others.
          }
        }
      }
    });
    return () => sub.remove();
  }, []);

  const isOffline = appState !== AppState.active;
  // True only while the app is offline, a ceremony has completed, and
  // the action has not yet settled. This is the window in which the
  // person may already have been charged, so the screen must show the
  // unconfirmed state rather than a failure.
  const disconnectedMedAction = ceremonyComplete && isOffline && !settled;

  const markCeremonyComplete = useCallback(() => {
    setCeremonyComplete(true);
  }, []);

  const markActionSettled = useCallback(() => {
    setSettled(true);
  }, []);

  const reset = useCallback(() => {
    setCeremonyComplete(false);
    setSettled(false);
  }, []);

  const onLineRecovered = useCallback((cb: () => void) => {
    listenersRef.current.add(cb);
    return () => {
      listenersRef.current.delete(cb);
    };
  }, []);

  return {
    isOffline,
    disconnectedMedAction,
    markCeremonyComplete,
    markActionSettled,
    reset,
    onLineRecovered,
  };
}
