import { useCallback, useMemo, useSyncExternalStore } from 'react';

import {
  getOriginGrants,
  isOriginPermissionsHydrated,
  revokeAllOriginPermissions,
  revokeOriginPermissions,
  subscribeToOriginGrants,
  type OriginGrant,
  type PermissionScope,
} from '../lib/permissions';

export type UseOriginPermissions = {
  /** Origins holding at least one grant, most recently granted first. */
  grants: OriginGrant[];
  /** Whether stored grants have been read yet. */
  isHydrated: boolean;
  /** Revoke one scope, or the whole origin when `scope` is omitted. */
  revoke: (origin: string, scope?: PermissionScope) => Promise<void>;
  /** Revoke every origin. */
  revokeAll: () => Promise<void>;
};

/**
 * Subscribe a component to the per-origin grant list.
 *
 * The same external-store shape as `useAppLock` / `useTheme`: a module-level
 * store rather than a context provider, so the settings screen and any live dApp
 * prompt read the same grants with nothing to wrap the tree in.
 *
 * Because the store notifies on revoke, an open dApp prompt re-renders on the
 * revoke rather than keeping a stale "allowed" answer on screen.
 */
export function useOriginPermissions(): UseOriginPermissions {
  const grants = useSyncExternalStore(subscribeToOriginGrants, getOriginGrants, getOriginGrants);
  const isHydrated = useSyncExternalStore(
    subscribeToOriginGrants,
    isOriginPermissionsHydrated,
    isOriginPermissionsHydrated
  );

  // Memory is updated before the write, so the list is correct the moment the
  // user taps; a failed write costs the revoke at next launch rather than
  // leaving the screen showing a permission that is already gone.
  const revoke = useCallback(async (origin: string, scope?: PermissionScope) => {
    await revokeOriginPermissions(origin, scope).catch(() => undefined);
  }, []);

  const revokeAll = useCallback(async () => {
    await revokeAllOriginPermissions().catch(() => undefined);
  }, []);

  return useMemo(
    () => ({ grants, isHydrated, revoke, revokeAll }),
    [grants, isHydrated, revoke, revokeAll]
  );
}
