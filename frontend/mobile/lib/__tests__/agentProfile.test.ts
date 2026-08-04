/**
 * AsyncStorage is a native module with no implementation under Jest, so it is
 * mocked with an in-memory map — the same approach `theme.test.ts` takes.
 */
const mockStorage = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      mockStorage.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      mockStorage.delete(key);
    }),
  },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  buildGreeting,
  buildNotificationMessage,
  consumeNotification,
  isAgentRole,
  loadProfile,
  NOTIFICATION_STORAGE_KEY,
  PROFILE_STORAGE_KEY,
  ROLES,
  saveProfile,
  suggestionsFor,
} from '../agentProfile';

beforeEach(() => {
  mockStorage.clear();
});

describe('isAgentRole', () => {
  it('accepts every advertised role and nothing else', () => {
    for (const role of ROLES) {
      expect(isAgentRole(role.value)).toBe(true);
    }
    expect(isAgentRole('whale')).toBe(false);
    expect(isAgentRole(undefined)).toBe(false);
  });
});

describe('buildGreeting', () => {
  it('greets by name when one is known', () => {
    expect(buildGreeting({ name: 'Ada', role: 'saver' })).toContain('Hey, Ada!');
    expect(buildGreeting({ role: 'saver' })).toContain('Hey!');
  });

  it('tailors the opener to the role', () => {
    expect(buildGreeting({ role: 'trader' })).toContain('trade');
    expect(buildGreeting({ role: 'investor' })).toContain('portfolio');
    expect(buildGreeting({ role: 'explorer' })).toContain('Welcome to Veil');
    expect(buildGreeting({})).toContain("I'm your Veil agent");
  });

  it('lets a pending notification take the opening line', () => {
    const notification = 'You received 10 XLM';
    expect(buildGreeting({ role: 'trader', name: 'Ada' }, notification)).toBe(notification);
  });
});

describe('buildNotificationMessage', () => {
  it('truncates the sender and keeps the amount', () => {
    const message = buildNotificationMessage(
      { role: 'saver', name: 'Ada' },
      { amount: '25', asset: 'USDC', from: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567' }
    );

    expect(message).toContain('Hey, Ada!');
    expect(message).toContain('**25 USDC**');
    expect(message).toContain('GABCDE…234567');
  });

  it('fills in defaults for a sparse notification', () => {
    const message = buildNotificationMessage({}, {});
    expect(message).toContain('**? XLM**');
    expect(message).toContain('someone');
  });
});

describe('suggestionsFor', () => {
  it('offers role-specific prompts', () => {
    expect(suggestionsFor({ role: 'saver' })).toContain('Send 50 XLM');
    expect(suggestionsFor({ role: 'trader' })).toContain('Show recent trades');
  });

  it('falls back to the generic set for an unknown role', () => {
    expect(suggestionsFor({ role: 'whale' })).toEqual(suggestionsFor({}));
  });
});

describe('profile persistence', () => {
  it('round-trips a profile', async () => {
    await saveProfile({ name: 'Ada', role: 'trader', language: 'Yoruba' });
    expect(await loadProfile()).toEqual({ name: 'Ada', role: 'trader', language: 'Yoruba' });
  });

  it('merges over what is already stored rather than replacing it', async () => {
    await saveProfile({ name: 'Ada', role: 'trader', language: 'English' });
    await saveProfile({ language: 'Igbo' });

    expect(await loadProfile()).toEqual({ name: 'Ada', role: 'trader', language: 'Igbo' });
  });

  it('treats a corrupt profile as absent, so the user is re-onboarded instead of stuck', async () => {
    await AsyncStorage.setItem(PROFILE_STORAGE_KEY, '{not json');
    expect(await loadProfile()).toEqual({});

    await AsyncStorage.setItem(PROFILE_STORAGE_KEY, 'null');
    expect(await loadProfile()).toEqual({});
  });

  it('reads the same storage key the web wallet writes', async () => {
    await AsyncStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify({ name: 'Ada', role: 'saver' }));
    expect(await loadProfile()).toEqual({ name: 'Ada', role: 'saver' });
  });
});

describe('consumeNotification', () => {
  it('announces a pending notification exactly once', async () => {
    await AsyncStorage.setItem(
      NOTIFICATION_STORAGE_KEY,
      JSON.stringify({ amount: '5', asset: 'XLM', from: 'GABCDEFGHIJKLMNOP' })
    );

    const first = await consumeNotification({ role: 'saver' });
    expect(first).toContain('**5 XLM**');

    expect(await consumeNotification({ role: 'saver' })).toBeNull();
    expect(await AsyncStorage.getItem(NOTIFICATION_STORAGE_KEY)).toBeNull();
  });

  it('returns null when there is nothing waiting', async () => {
    expect(await consumeNotification({})).toBeNull();
  });

  it('clears a corrupt notification rather than reporting it every visit', async () => {
    await AsyncStorage.setItem(NOTIFICATION_STORAGE_KEY, '{broken');

    expect(await consumeNotification({})).toBeNull();
    expect(await AsyncStorage.getItem(NOTIFICATION_STORAGE_KEY)).toBeNull();
  });
});
