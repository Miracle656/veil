import { useCallback, useMemo, useSyncExternalStore } from 'react';

import {
  THEMES,
  getTheme,
  isThemeHydrated,
  setTheme as setStoredTheme,
  subscribeToTheme,
  toggleTheme,
  getThemePreference,
  getSystemTheme,
  type Theme,
  type ThemePreference,
  type ThemeColors,
} from '../lib/theme';

export type UseTheme = {
  /** The active theme. */
  theme: Theme;
  /** The active theme's colours. */
  colors: ThemeColors;
  /** Convenience for the common branch. */
  isDark: boolean;
  /** What the user chose: 'light', 'dark' or 'system'. */
  preference: ThemePreference;
  /** The scheme the OS reports, whatever the preference. */
  systemTheme: Theme;
  /** Whether the stored preference has been read yet. */
  isHydrated: boolean;
  /** Flip between light and dark, persisting the result. */
  toggle: () => void;
  /** Select a theme explicitly. */
  /** Choose light, dark, or follow the device. */
  select: (preference: ThemePreference) => void;
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
  // Subscribed rather than read directly, for the same reason as `theme`:
  // a bare module read is something the React Compiler may cache.
  const preference = useSyncExternalStore(
    subscribeToTheme,
    getThemePreference,
    getThemePreference,
  );
  const systemTheme = useSyncExternalStore(subscribeToTheme, getSystemTheme, getSystemTheme);
  const isHydrated = useSyncExternalStore(subscribeToTheme, isThemeHydrated, isThemeHydrated);

  const toggle = useCallback(() => {
    // Persistence failures are not worth interrupting the user over; the theme
    // has already flipped on screen either way.
    void toggleTheme().catch(() => undefined);
  }, []);

  const select = useCallback((next: ThemePreference) => {
    void setStoredTheme(next).catch(() => undefined);
  }, []);

  return useMemo(
    () => ({
      theme,
      colors: THEMES[theme],
      isDark: theme === 'dark',
      preference,
      systemTheme,
      isHydrated,
      toggle,
      select,
    }),
    [theme, preference, systemTheme, isHydrated, toggle, select]
  );
}
