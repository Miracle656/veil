import { useCallback, useMemo, useSyncExternalStore } from 'react';

import {
  THEMES,
  getTheme,
  isThemeHydrated,
  setTheme as setStoredTheme,
  subscribeToTheme,
  toggleTheme,
  type Theme,
  type ThemeColors,
} from '../lib/theme';

export type UseTheme = {
  /** The active theme. */
  theme: Theme;
  /** The active theme's colours. */
  colors: ThemeColors;
  /** Convenience for the common branch. */
  isDark: boolean;
  /** Whether the stored preference has been read yet. */
  isHydrated: boolean;
  /** Flip between light and dark, persisting the result. */
  toggle: () => void;
  /** Select a theme explicitly. */
  select: (theme: Theme) => void;
};

/**
 * Subscribe a component to the active theme.
 *
 * The external-store snapshot is the theme *name* rather than the colour
 * object: `useSyncExternalStore` compares snapshots by identity, and a string
 * compares by value, so components re-render exactly when the theme changes.
 * The colours are derived from it, and `THEMES` entries are stable module
 * constants, so `colors` keeps a stable identity for as long as the theme does
 * and is safe in a `useMemo` dependency list.
 *
 * No provider is required — matching the web wallet's `useTheme`, which is also
 * standalone.
 */
export function useTheme(): UseTheme {
  const theme = useSyncExternalStore(subscribeToTheme, getTheme, getTheme);
  const isHydrated = useSyncExternalStore(subscribeToTheme, isThemeHydrated, isThemeHydrated);

  const toggle = useCallback(() => {
    // Persistence failures are not worth interrupting the user over; the theme
    // has already flipped on screen either way.
    void toggleTheme().catch(() => undefined);
  }, []);

  const select = useCallback((next: Theme) => {
    void setStoredTheme(next).catch(() => undefined);
  }, []);

  return useMemo(
    () => ({
      theme,
      colors: THEMES[theme],
      isDark: theme === 'dark',
      isHydrated,
      toggle,
      select,
    }),
    [theme, isHydrated, toggle, select]
  );
}
