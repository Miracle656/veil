import { useCallback, useMemo, useSyncExternalStore } from 'react';

import {
  getLockSettings,
  isLockSettingsHydrated,
  setLockTimeout as setStoredLockTimeout,
  setRequireBiometrics as setStoredRequireBiometrics,
  subscribeToLockSettings,
  type LockSettings,
  type LockTimeout,
} from '../lib/appLock';

export type UseAppLock = LockSettings & {
  /** Whether the stored preferences have been read yet. */
  isHydrated: boolean;
  /** Choose how long the app may sit idle before locking. */
  selectTimeout: (timeout: LockTimeout) => void;
  /** Choose whether unlocking must present a biometric factor. */
  selectRequireBiometrics: (required: boolean) => void;
};

/**
 * Subscribe a component to the app-lock policy.
 *
 * Follows the same shape as `useTheme`: a module-level store rather than a
 * context provider, so the settings screen and any future lock screen read the
 * same values with nothing to wrap the tree in.
 *
 * `getLockSettings` returns a stable object that is replaced only when a
 * setting changes, which is exactly the identity comparison
 * `useSyncExternalStore` performs — so a component re-renders when the policy
 * changes and not otherwise.
 */
export function useAppLock(): UseAppLock {
  const settings = useSyncExternalStore(subscribeToLockSettings, getLockSettings, getLockSettings);
  const isHydrated = useSyncExternalStore(
    subscribeToLockSettings,
    isLockSettingsHydrated,
    isLockSettingsHydrated
  );

  // The setting is applied in memory before it is persisted, so a failed write
  // costs the preference at next launch rather than the interaction now. That
  // makes it not worth interrupting the user over.
  const selectTimeout = useCallback((timeout: LockTimeout) => {
    void setStoredLockTimeout(timeout).catch(() => undefined);
  }, []);

  const selectRequireBiometrics = useCallback((required: boolean) => {
    void setStoredRequireBiometrics(required).catch(() => undefined);
  }, []);

  return useMemo(
    () => ({ ...settings, isHydrated, selectTimeout, selectRequireBiometrics }),
    [settings, isHydrated, selectTimeout, selectRequireBiometrics]
  );
}
