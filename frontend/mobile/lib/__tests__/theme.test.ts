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
    expect(theme.getThemeColors().background).toBe('#0B0B0F');
    expect(theme.getThemeColors().textStrong).toBe('#FFFFFF');
  });
});

describe('persistence', () => {
  it('restores a stored light preference', async () => {
    mockStorage.set(STORAGE_KEY, 'light');
    const theme = await loadTheme();
    expect(theme.getTheme()).toBe('light');
    expect(theme.getThemeColors().background).toBe('#F6F7F9');
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

  it('does not notify when the theme is unchanged', async () => {
    const theme = await loadTheme();
    const listener = jest.fn();
    theme.subscribeToTheme(listener);

    await theme.setTheme('dark');
    expect(listener).not.toHaveBeenCalled();
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
