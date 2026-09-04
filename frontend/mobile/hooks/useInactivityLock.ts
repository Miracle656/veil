import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useRouter, useSegments } from 'expo-router';

import Constants, { ExecutionEnvironment } from 'expo-constants';

import { createIdleWatcher } from '../lib/appLock';
import { getWalletAddress } from '../lib/walletStore';

/** True in Expo Go, where native passkeys don't exist. */
const IN_EXPO_GO = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

/**
 * Locks the wallet after inactivity or when the app is backgrounded, so a lost
 * or borrowed phone doesn't expose funds.
 *
 * The countdown lives in `lib/appLock.ts`; this hook wires it to React Native's
 * `AppState` and expo-router. Sending the app to the background locks it
 * immediately; returning to the foreground restarts the idle countdown. Either
 * trigger routes to `/lock`, which re-prompts a biometric. It re-arms itself off
 * the current route so it never fights the lock screen it just pushed.
 *
 * The lock only arms once a wallet exists. Before then there is nothing to
 * protect, and `/lock` would be a dead end — there is no passkey to unlock with —
 * so an onboarding user must never be sent there. (This is also what stops a
 * fresh install from being trapped on the lock screen the moment Expo Go hands
 * off to the project and fires an `AppState` background event.)
 *
 * Mount once at the app root (alongside the connectivity gate in `_layout.tsx`).
 */
export function useInactivityLock(): void {
  const router = useRouter();
  const segments = useSegments();
  const onLockRoute = segments[0] === 'lock';

  useEffect(() => {
    // Already locked — don't re-arm on top of the lock screen.
    if (onLockRoute) return;

    let cancelled = false;
    let cleanup: (() => void) | undefined;

    (async () => {
      const wallet = await getWalletAddress().catch(() => null);
      if (cancelled || !wallet) return; // no wallet → never lock

      // The lock screen can only be dismissed with a passkey. In Expo Go there is
      // no passkey native module, so locking would trap the user — don't arm it.
      // (Checked via expo-constants, NOT by loading the passkey module, which
      // would itself log a native-module error just by being required.) A dev
      // build / standalone locks normally.
      if (IN_EXPO_GO) return;

      const lock = () => router.replace('/lock');
      const watcher = createIdleWatcher({ onLock: lock });
      watcher.start();

      // Locking the instant the app is backgrounded makes every app switch a
      // biometric round-trip (brutal while testing, and jarring in real use).
      // Instead: pause the idle watcher while backgrounded and require the
      // unlock only when the app was away longer than a short grace window.
      const BACKGROUND_GRACE_MS = 60_000;
      let backgroundedAt: number | null = null;

      const subscription = AppState.addEventListener('change', (state) => {
        if (state === 'background') {
          watcher.stop();
          backgroundedAt = Date.now();
        } else if (state === 'active') {
          const away = backgroundedAt ? Date.now() - backgroundedAt : 0;
          backgroundedAt = null;
          if (away > BACKGROUND_GRACE_MS) {
            lock();
          } else {
            watcher.start();
          }
        }
      });

      cleanup = () => {
        watcher.stop();
        subscription.remove();
      };
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [router, onLockRoute]);
}
