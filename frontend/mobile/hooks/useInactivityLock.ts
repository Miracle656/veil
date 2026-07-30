import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useRouter, useSegments } from 'expo-router';

import { createIdleWatcher } from '../lib/appLock';

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
 * Mount once at the app root (alongside the connectivity gate in `_layout.tsx`).
 */
export function useInactivityLock(): void {
  const router = useRouter();
  const segments = useSegments();
  const onLockRoute = segments[0] === 'lock';

  useEffect(() => {
    // Already locked — don't re-arm on top of the lock screen.
    if (onLockRoute) return;

    const lock = () => router.replace('/lock');
    const watcher = createIdleWatcher({ onLock: lock });
    watcher.start();

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        // Backgrounded: lock now so returning requires a biometric.
        watcher.stop();
        lock();
      }
    });

    return () => {
      watcher.stop();
      subscription.remove();
    };
  }, [router, onLockRoute]);
}
