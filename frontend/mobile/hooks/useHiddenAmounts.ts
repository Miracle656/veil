import { useCallback, useMemo, useSyncExternalStore } from 'react';

import {
  AMOUNT_MASK,
  getHiddenAmounts,
  isHiddenAmountsHydrated,
  maskAmount,
  setHiddenAmounts,
  subscribeToHiddenAmounts,
  toggleHiddenAmounts,
} from '../lib/hiddenAmounts';

export type UseHiddenAmounts = {
  /** Whether amounts are currently masked. */
  hidden: boolean;
  /** Whether the stored preference has been read yet. */
  isHydrated: boolean;
  /** Flip the preference, persisting the result. */
  toggle: () => void;
  /** Set the preference explicitly. */
  setHidden: (hidden: boolean) => void;
  /** Mask a pre-formatted amount string when hiding is on. */
  mask: (value: string) => string;
};

/**
 * Subscribe a component to the "hide amounts" preference.
 *
 * Same standalone external-store shape as `useTheme`: no provider, re-renders
 * exactly its subscribers when the toggle flips. `mask()` is bound to the
 * current state so a component reads `mask(formatted)` without threading the
 * boolean through its own props.
 */
export function useHiddenAmounts(): UseHiddenAmounts {
  const hidden = useSyncExternalStore(
    subscribeToHiddenAmounts,
    getHiddenAmounts,
    getHiddenAmounts,
  );
  const isHydrated = useSyncExternalStore(
    subscribeToHiddenAmounts,
    isHiddenAmountsHydrated,
    isHiddenAmountsHydrated,
  );

  const toggle = useCallback(() => {
    void toggleHiddenAmounts().catch(() => undefined);
  }, []);

  const setHidden = useCallback((next: boolean) => {
    void setHiddenAmounts(next).catch(() => undefined);
  }, []);

  const mask = useCallback((value: string) => maskAmount(hidden, value, AMOUNT_MASK), [hidden]);

  return useMemo(
    () => ({ hidden, isHydrated, toggle, setHidden, mask }),
    [hidden, isHydrated, toggle, setHidden, mask],
  );
}
