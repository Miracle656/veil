/**
 * Tests for theme selection and persistence.
 *
 * `lib/theme.ts` holds module-level state hydrated once from storage, so most
 * cases need a fresh module instance. `loadTheme` handles that: reset the
 * registry, import, and wait for hydration.
 */

const mockStorage = new Map<string, string>();
let mockGetItemError: Error | null = null;

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => {
      if (mockGetItemError) throw mockGetItemError;
      return mockStorage.get(key) ?? null;
    }),
    setItem: jest.fn(async (key: string, value: string) => {
      mockStorage.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      mockStorage.delete(key);
    }),
  },
}));

type ThemeModule = typeof import('../theme');

const STORAGE_KEY = 'veil_theme';

/** Import a fresh copy of lib/theme.ts and wait for hydration to settle. */
async function loadTheme(): Promise<ThemeModule> {
  jest.resetModules();
  const mod: ThemeModule = require('../theme');
  await mod.hydrateTheme();
  return mod;
}

beforeEach(() => {
  mockStorage.clear();
  mockGetItemError = null;
});

describe('default theme', () => {
  it('is dark when nothing has been stored', async () => {
    const theme = await loadTheme();
    expect(theme.getTheme()).toBe('dark');
  });

  it('matches the palette the app already shipped with', async () => {
    const theme = await loadTheme();
    expect(theme.getThemeColors().background).toBe('#0F0F0F');
    expect(theme.getThemeColors().textStrong).toBe('#FFFFFF');
  });
});

describe('persistence', () => {
  it('restores a stored light preference', async () => {
    mockStorage.set(STORAGE_KEY, 'light');
    const theme = await loadTheme();
    expect(theme.getTheme()).toBe('light');
    expect(theme.getThemeColors().background).toBe('#FFFFFF');
  });

  it('writes the choice to storage', async () => {
    const theme = await loadTheme();
    await theme.setTheme('light');
    expect(mockStorage.get(STORAGE_KEY)).toBe('light');
  });

  it('survives a reload', async () => {
    const first = await loadTheme();
    await first.toggleTheme();

    const second = await loadTheme();
    expect(second.getTheme()).toBe('light');
  });

  it('ignores a stored value that is not a theme', async () => {
    mockStorage.set(STORAGE_KEY, 'solarized');
    const theme = await loadTheme();
    expect(theme.getTheme()).toBe('dark');
  });

  it('falls back to the default when storage is unreadable', async () => {
    mockGetItemError = new Error('storage unavailable');
    const theme = await loadTheme();
    expect(theme.getTheme()).toBe('dark');
    expect(theme.isThemeHydrated()).toBe(true);
  });

  it('reads storage once no matter how often hydration is requested', async () => {
    const theme = await loadTheme();
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    const before = AsyncStorage.getItem.mock.calls.length;
    await Promise.all([theme.hydrateTheme(), theme.hydrateTheme()]);
    expect(AsyncStorage.getItem.mock.calls.length).toBe(before);
  });
});

describe('toggleTheme', () => {
  it('flips dark to light and back', async () => {
    const theme = await loadTheme();
    await expect(theme.toggleTheme()).resolves.toBe('light');
    await expect(theme.toggleTheme()).resolves.toBe('dark');
    expect(mockStorage.get(STORAGE_KEY)).toBe('dark');
  });

  it('applies the change even when the write fails', async () => {
    const theme = await loadTheme();
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    AsyncStorage.setItem.mockRejectedValueOnce(new Error('disk full'));

    await expect(theme.toggleTheme()).rejects.toThrow('disk full');
    // The user tapped a toggle; it moves regardless of what storage did.
    expect(theme.getTheme()).toBe('light');
  });
});

describe('setTheme', () => {
  it('rejects an unknown theme', async () => {
    const theme = await loadTheme();
    await expect(theme.setTheme('solarized' as never)).rejects.toThrow(/Unknown theme/);
  });

  it('still persists when the theme is already active', async () => {
    const theme = await loadTheme();
    await theme.setTheme('dark');
    expect(mockStorage.get(STORAGE_KEY)).toBe('dark');
  });
});

describe('subscribeToTheme', () => {
  it('notifies subscribers on a change', async () => {
    const theme = await loadTheme();
    const listener = jest.fn();
    theme.subscribeToTheme(listener);

    await theme.setTheme('light');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not notify when the preference is unchanged', async () => {
    const theme = await loadTheme();
    const listener = jest.fn();
    theme.subscribeToTheme(listener);

    // Re-selecting what is already chosen is a no-op.
    await theme.setTheme(theme.getThemePreference());
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies on a preference change even when the resolved theme is the same', async () => {
    // Selecting "Follow device" on a phone already showing dark moves no
    // pixel of the palette, but the settings list has to re-tick the chosen
    // row — so the store notifies on the preference, not just the colours.
    const theme = await loadTheme();
    await theme.setTheme('dark');

    const listener = jest.fn();
    theme.subscribeToTheme(listener);

    await theme.setTheme('system');

    expect(listener).toHaveBeenCalled();
    expect(theme.getThemePreference()).toBe('system');
  });

  it('notifies once hydration settles, so a pre-hydration render updates', async () => {
    jest.resetModules();
    mockStorage.set(STORAGE_KEY, 'light');

    const theme: ThemeModule = require('../theme');
    const listener = jest.fn();
    theme.subscribeToTheme(listener);
    expect(theme.isThemeHydrated()).toBe(false);

    await theme.hydrateTheme();

    expect(listener).toHaveBeenCalled();
    expect(theme.isThemeHydrated()).toBe(true);
    expect(theme.getTheme()).toBe('light');
  });

  it('stops notifying after unsubscribe', async () => {
    const theme = await loadTheme();
    const listener = jest.fn();
    theme.subscribeToTheme(listener)();

    await theme.setTheme('light');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('palette', () => {
  it('defines every colour role in both themes', async () => {
    const { THEMES } = await loadTheme();
    const darkRoles = Object.keys(THEMES.dark).sort();
    const lightRoles = Object.keys(THEMES.light).sort();
    expect(lightRoles).toEqual(darkRoles);
  });

  it('gives every role a distinct value per theme, so nothing is left unthemed', async () => {
    const { THEMES } = await loadTheme();
    const shared = Object.keys(THEMES.dark).filter(
      (role) =>
        THEMES.dark[role as keyof typeof THEMES.dark]
        === THEMES.light[role as keyof typeof THEMES.light]
    );
    // onAccent is white in both: it sits on the accent fill, not the background.
    expect(shared).toEqual(['onAccent']);
  });
});

/**
 * Load theme.ts with the device reporting a given colour scheme.
 *
 * The spy has to be installed AFTER `jest.resetModules()` and before requiring
 * theme.ts: resetting the registry hands out a fresh `react-native`, so a spy
 * placed on the previous copy of `Appearance` is not the one theme.ts reads.
 */
async function loadThemeWithScheme(scheme: 'light' | 'dark'): Promise<ThemeModule> {
  jest.resetModules();
  const rn = require('react-native');
  jest.spyOn(rn.Appearance, 'getColorScheme').mockReturnValue(scheme);
  const mod: ThemeModule = require('../theme');
  await mod.hydrateTheme();
  return mod;
}

describe('system preference', () => {
  it('follows the device scheme when set to system', async () => {
    const theme = await loadThemeWithScheme('light');
    await theme.setTheme('system');

    expect(theme.getThemePreference()).toBe('system');
    expect(theme.getTheme()).toBe('light');
    expect(theme.getThemeColors().background).toBe('#FFFFFF');
  });

  it('ignores the device once the user pins a theme', async () => {
    const theme = await loadThemeWithScheme('light');
    await theme.setTheme('dark');

    // The device says light; the user said dark, and the user wins.
    expect(theme.getTheme()).toBe('dark');
    expect(theme.getSystemTheme()).toBe('light');
  });

  it('persists "system" rather than the colour it happened to resolve to', async () => {
    // Storing the resolved value would freeze the choice: a user who picked
    // "follow device" on a dark evening would be pinned to dark next morning.
    const theme = await loadTheme();
    await theme.setTheme('system');

    expect(mockStorage.get(STORAGE_KEY)).toBe('system');

    const reloaded = await loadTheme();
    expect(reloaded.getThemePreference()).toBe('system');
  });

  it('still accepts a bare light/dark written by an older build', async () => {
    mockStorage.set(STORAGE_KEY, 'light');
    const theme = await loadTheme();

    expect(theme.getThemePreference()).toBe('light');
    expect(theme.getTheme()).toBe('light');
  });

  it('toggles away from what is on screen, not from the preference', async () => {
    const theme = await loadThemeWithScheme('light');
    await theme.setTheme('system'); // resolves to light

    await theme.toggleTheme();

    // Pressing a toggle means "give me the other one to what I can see".
    expect(theme.getTheme()).toBe('dark');
    expect(theme.getThemePreference()).toBe('dark');
  });
});

describe('surface tokens', () => {
  /**
   * `surface` is a translucent tint; `surfaceRaised` is an opaque fill.
   * Confusing the two is invisible in review — it compiles, it type-checks, and
   * it looks right on any screen where the page happens to sit behind it. It
   * only shows up as a modal you can read the settings list through.
   */
  it('surfaceRaised is fully opaque in both themes', async () => {
    const { THEMES } = await loadTheme();
    for (const name of ['dark', 'light'] as const) {
      expect(THEMES[name].surfaceRaised).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('surface is translucent, and so cannot be a fill over a scrim', async () => {
    const { THEMES } = await loadTheme();
    for (const name of ['dark', 'light'] as const) {
      expect(THEMES[name].surface).toMatch(/^rgba\(/);
    }
  });

  it('background is opaque in both themes', async () => {
    const { THEMES } = await loadTheme();
    for (const name of ['dark', 'light'] as const) {
      expect(THEMES[name].background).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});
