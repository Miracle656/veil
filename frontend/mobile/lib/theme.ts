/**
 * Light/dark theming for the mobile app.
 *
 * The web wallet's `useTheme` keeps its state in `localStorage` and applies it
 * by setting `data-theme` on the document root, letting CSS variables do the
 * restyling (`frontend/wallet/hooks/useTheme.ts`). React Native has neither a
 * document nor cascading variables, so the palette is data: a `ThemeColors`
 * record per theme that components read and style from.
 *
 * The active theme lives in module state rather than a context provider, which
 * keeps the hook's ergonomics the same as the web's — `useTheme()` works
 * anywhere, with nothing to wrap the tree in — while still driving every
 * subscriber from a single source of truth.
 *
 * The storage key matches the web wallet's, so the two clients describe the
 * user's preference the same way.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Appearance } from 'react-native';

export type Theme = 'dark' | 'light';

/**
 * What the user chose, which is not the same thing as what is on screen.
 *
 * 'system' resolves to whichever scheme the OS reports, and follows it while
 * the app is open — so a phone on an automatic day/night schedule changes the
 * wallet with it. `Theme` stays the *resolved* value, so every screen keeps
 * styling from two concrete palettes and none of them has to know a preference
 * exists.
 */
export type ThemePreference = Theme | 'system';

/** AsyncStorage key holding the user's theme preference. */
export const THEME_STORAGE_KEY = 'veil_theme';

/**
 * The colour roles every screen styles from. Kept deliberately small — one
 * token per job, not one per screen — so adding a screen does not mean adding
 * tokens, and so a missing light-mode value is impossible rather than merely
 * unlikely.
 */
export type ThemeColors = {
  /** Screen background. */
  background: string;
  /**
   * Cards, inputs, and list containers sitting on the background.
   *
   * Translucent by design — it tints whatever is behind it. That only reads as
   * a surface when `background` is what is behind it, so anything floating over
   * a scrim (a modal, a sheet) needs {@link surfaceRaised} instead.
   */
  surface: string;
  /**
   * Opaque fill for surfaces that float over arbitrary content: modals, sheets,
   * popovers. Distinct from `surface` because those cannot borrow the page's
   * background to sit on, and distinct from `background` so a modal reads as
   * lifted off the page rather than flush with it.
   */
  surfaceRaised: string;
  /** Raised surface — quick-action tiles, tx icon chips (artboard `surface-md`). */
  surfaceMd: string;
  /** Borders, dividers, and secondary button fills. */
  border: string;
  /** Screen and section titles. */
  textStrong: string;
  /** Body text and input contents. */
  textPrimary: string;
  /** Supporting copy under a title. */
  textSecondary: string;
  /** De-emphasised detail text. */
  textMuted: string;
  /** Placeholders and overline labels. */
  textFaint: string;
  /** Primary action colour. */
  accent: string;
  /** Accent used as text on the background (totals, highlights). */
  accentText: string;
  /** Text and spinners drawn on top of `accent`. */
  onAccent: string;
  /** Destructive actions and error text. */
  danger: string;
  /** Fill behind error text. */
  dangerSurface: string;
  /** Uppercase Anton section labels (artboard `grey`). */
  label: string;
  /** Positive movement — gains, received transfers, up-deltas (artboard `teal`). */
  positive: string;
  /** Fill/border behind positive pills. */
  positiveSurface: string;
  /** Swaps and secondary accents (artboard `lilac`). */
  lilac: string;
};

/**
 * Veil brand palette — gold (`#FDDA24`) on near-black (`#0F0F0F`), matching the
 * web wallet's `--gold` / `--near-black` / `--off-white` tokens. Light mode uses
 * the web wallet's darker `#C4A800` gold so the accent keeps contrast on white.
 * (Replaces an earlier indigo/slate palette that had drifted off-brand.)
 */
export const THEMES: Record<Theme, ThemeColors> = {
  dark: {
    background: '#0F0F0F',
    surface: 'rgba(255,255,255,0.03)',
    surfaceRaised: '#1C1C1E',
    surfaceMd: 'rgba(255,255,255,0.06)',
    border: 'rgba(255,255,255,0.08)',
    textStrong: '#FFFFFF',
    textPrimary: '#F6F7F8',
    textSecondary: 'rgba(246,247,248,0.62)',
    textMuted: 'rgba(246,247,248,0.55)',
    textFaint: 'rgba(246,247,248,0.35)',
    accent: '#FDDA24',
    accentText: '#FDDA24',
    onAccent: '#0F0F0F',
    danger: '#E06A5B',
    dangerSurface: 'rgba(224,106,91,0.14)',
    label: '#D6D2C4',
    positive: '#00A7B5',
    positiveSurface: 'rgba(0,167,181,0.12)',
    lilac: '#B7ACE8',
  },
  light: {
    background: '#FFFFFF',
    surface: 'rgba(0,0,0,0.02)',
    surfaceRaised: '#FFFFFF',
    surfaceMd: 'rgba(0,0,0,0.04)',
    border: 'rgba(0,0,0,0.10)',
    textStrong: '#0F0F0F',
    textPrimary: '#1A1A1A',
    textSecondary: '#4B5563',
    textMuted: '#6B7280',
    textFaint: '#9CA3AF',
    accent: '#C4A800',
    accentText: '#8A7600',
    onAccent: '#0F0F0F',
    danger: '#C4442F',
    dangerSurface: 'rgba(196,68,47,0.10)',
    label: '#6B7280',
    positive: '#00838F',
    positiveSurface: 'rgba(0,131,143,0.10)',
    lilac: '#6C5CB0',
  },
};

/** The theme used before a stored preference has been read. */
export const DEFAULT_THEME: Theme = 'dark';

/** Narrow an arbitrary value to a known theme name. */
export function isTheme(value: unknown): value is Theme {
  return value === 'dark' || value === 'light';
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return isTheme(value) || value === 'system';
}

/** The default preference: follow the device unless the user says otherwise. */
export const DEFAULT_PREFERENCE: ThemePreference = 'system';

// ── Active theme ─────────────────────────────────────────────────────────────────

let activePreference: ThemePreference = DEFAULT_PREFERENCE;
let systemTheme: Theme = Appearance.getColorScheme() === 'light' ? 'light' : 'dark';
let hydrated = false;
const listeners = new Set<() => void>();

/**
 * Follow the OS while the preference is 'system'.
 *
 * The listener stays attached regardless of the current preference: the user
 * can switch to 'system' at any point, and re-subscribing on every preference
 * change is more moving parts than simply keeping `systemTheme` current. It
 * only notifies when the resolved theme actually moves, so an OS change while
 * pinned to light or dark costs nothing.
 */
Appearance.addChangeListener(({ colorScheme }) => {
  const next: Theme = colorScheme === 'light' ? 'light' : 'dark';
  if (next === systemTheme) return;
  const before = resolveTheme();
  systemTheme = next;
  if (resolveTheme() !== before) notify();
});

/** The theme actually in effect, given the preference and the OS. */
function resolveTheme(): Theme {
  return activePreference === 'system' ? systemTheme : activePreference;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Subscribe to theme changes.
 *
 * @returns An unsubscribe function.
 */
export function subscribeToTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The active theme — resolved, never 'system'. Cheap enough to call in a render. */
export function getTheme(): Theme {
  return resolveTheme();
}

/** What the user chose: 'light', 'dark' or 'system'. */
export function getThemePreference(): ThemePreference {
  return activePreference;
}

/** The scheme the OS is currently reporting. */
export function getSystemTheme(): Theme {
  return systemTheme;
}

/** The active theme's colours. */
export function getThemeColors(): ThemeColors {
  return THEMES[resolveTheme()];
}

/** Whether the stored preference has been read yet. */
export function isThemeHydrated(): boolean {
  return hydrated;
}

// ── Hydration ────────────────────────────────────────────────────────────────────

let hydration: Promise<Theme> | null = null;

/**
 * Load the stored preference. Idempotent: repeated calls share one read, so the
 * hook can call it from every mounted component without extra storage hits.
 */
export function hydrateTheme(): Promise<Theme> {
  hydration ??= AsyncStorage.getItem(THEME_STORAGE_KEY)
    .catch(() => null)
    .then((stored) => {
      hydrated = true;
      // Accepts a bare 'light'/'dark' too: that is what older builds wrote, and
      // a stored preference from before 'system' existed is still a valid
      // choice rather than something to discard.
      if (isThemePreference(stored) && stored !== activePreference) {
        activePreference = stored;
      }
      // Notify unconditionally: a component that rendered pre-hydration needs to
      // know the preference has settled even when it settled on the default.
      notify();
      return resolveTheme();
    });
  return hydration;
}

// Start reading at import so the stored preference is usually in place by the
// time the first screen paints.
void hydrateTheme();

// ── Switching ────────────────────────────────────────────────────────────────────

/**
 * Set the theme and persist it.
 *
 * The theme is applied immediately and persisted in the background: a user
 * tapping a toggle should see it move, and a failed write costs them the
 * preference on next launch rather than the interaction now.
 */
export async function setTheme(preference: ThemePreference): Promise<void> {
  if (!isThemePreference(preference)) throw new Error(`Unknown theme: ${preference}`);

  if (preference !== activePreference) {
    activePreference = preference;
    // Notify on any preference change, including one where the resolved theme
    // does not move. Picking "Follow device" on a phone that is already dark
    // changes no pixel of the palette, but the settings list shows which
    // option is ticked — and that has to update.
    notify();
  }
  hydration = Promise.resolve(resolveTheme());
  hydrated = true;

  await AsyncStorage.setItem(THEME_STORAGE_KEY, preference);
}

/**
 * Flip between light and dark, persisting the result.
 *
 * Flips away from whatever is currently *on screen*, so toggling while on
 * 'system' pins the opposite of what the OS is giving — which is what a user
 * pressing a toggle means. Selecting 'system' again is done through
 * {@link setTheme}.
 */
export async function toggleTheme(): Promise<Theme> {
  const next: Theme = resolveTheme() === 'dark' ? 'light' : 'dark';
  await setTheme(next);
  return next;
}
