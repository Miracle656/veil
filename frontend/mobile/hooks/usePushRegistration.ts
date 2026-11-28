/**
 * Register this install for remote push once the user has a wallet (#1273).
 *
 * Mounted once at the app root. It waits until the user is inside the main tabs
 * AND a wallet exists on this network, then asks for notification permission
 * (the same path local notifications use) and registers the push token. A
 * permission dialog shown to someone who has not yet seen the app is one that
 * gets refused, so nothing here runs during onboarding.
 *
 * Every wallet path — create, recover, passkey login, a classic import — ends in
 * the tabs with an address saved, so keying on that covers them all without
 * touching each flow.
 */

import { useEffect } from 'react';
import { Platform } from 'react-native';
import { useSegments } from 'expo-router';

import { ensurePushRegistration, watchPushTokenRotation } from '../lib/pushToken';
import { getWalletAddress } from '../lib/walletStore';

/** One attempt per app session; a relaunch tries again, and the registry upsert is idempotent. */
let attempted = false;
let stopWatching: (() => void) | null = null;

/** Statuses after which a later token rotation is worth re-registering. */
const WATCH_AFTER = new Set(['registered', 'no-registry', 'failed']);

/**
 * Run one registration if the user is in the app and has a wallet. Exported for
 * tests; the hook is the only production caller.
 */
export async function maybeRegisterForPush(
  inTabs: boolean,
  deps: {
    walletAddress?: () => Promise<string | null>;
    register?: typeof ensurePushRegistration;
    watch?: typeof watchPushTokenRotation;
  } = {},
): Promise<void> {
  if (attempted || !inTabs || Platform.OS === 'web') return;
  const address = await (deps.walletAddress ?? getWalletAddress)();
  if (!address || attempted) return;
  attempted = true;

  const result = await (deps.register ?? ensurePushRegistration)();
  if (WATCH_AFTER.has(result.status) && !stopWatching) {
    stopWatching = (deps.watch ?? watchPushTokenRotation)();
  }
}

/** Forget the session's attempt and stop watching. Tests only. */
export function resetPushRegistrationForTests(): void {
  attempted = false;
  stopWatching?.();
  stopWatching = null;
}

export function usePushRegistration(): void {
  const segments = useSegments();
  const inTabs = segments[0] === '(tabs)';

  useEffect(() => {
    void maybeRegisterForPush(inTabs);
  }, [inTabs]);
}
