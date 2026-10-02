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
  DEFAULT_PROFILE,
  isAgentRole,
  LANGUAGES,
  loadProfile,
  MAX_NAME_LENGTH,
  nameProblem,
  normaliseProfile,
  NOTIFICATION_STORAGE_KEY,
  PERSONAS,
  PROFILE_STORAGE_KEY,
  replaceProfile,
  resetProfile,
  ROLES,
  saveProfile,
  suggestionsFor,
} from '../agentProfile';

type AgentProfileModule = typeof import('../agentProfile');

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

describe('the profile fields', () => {
  it('offers exactly the roles the web page offers', () => {
    expect(ROLES.map((role) => [role.value, role.label])).toEqual([
      ['trader', 'Trader'],
      ['investor', 'Investor'],
      ['saver', 'Saver'],
      ['explorer', 'Explorer'],
    ]);
  });

  it('offers exactly the fifteen languages the web page offers', () => {
    expect(LANGUAGES).toEqual([
      'English', 'Spanish', 'French', 'Portuguese', 'Chinese', 'Japanese',
      'Korean', 'Arabic', 'Hindi', 'Russian', 'German', 'Turkish', 'Yoruba', 'Igbo', 'Swahili',
    ]);
  });

  it('offers exactly the five personas the web page offers, Default included', () => {
    expect(PERSONAS.map((persona) => [persona.value, persona.label])).toEqual([
      ['', 'Default'],
      ['concise and direct', 'Concise'],
      ['friendly and casual', 'Casual'],
      ['detailed and educational', 'Teacher'],
      ['witty and fun', 'Fun'],
    ]);
  });

  it('starts from the same defaults the web page resets to', () => {
    expect(DEFAULT_PROFILE).toEqual({ name: '', language: 'English', persona: '', role: '' });
  });
});

describe('normaliseProfile', () => {
  it('answers every field, filling the gaps with the web defaults', () => {
    expect(normaliseProfile({ role: 'saver' })).toEqual({
      name: '',
      language: 'English',
      persona: '',
      role: 'saver',
    });
  });

  it('keeps every value the app actually offers', () => {
    for (const role of ROLES) {
      expect(normaliseProfile({ role: role.value }).role).toBe(role.value);
    }
    for (const language of LANGUAGES) {
      expect(normaliseProfile({ language }).language).toBe(language);
    }
    for (const persona of PERSONAS) {
      expect(normaliseProfile({ persona: persona.value }).persona).toBe(persona.value);
    }
  });

  it('refuses a role, language or persona the app does not offer', () => {
    expect(normaliseProfile({ role: 'whale', language: 'Klingon', persona: 'sarcastic' })).toEqual(
      DEFAULT_PROFILE
    );
  });

  it('treats a value of the wrong type as unanswered rather than coercing it', () => {
    expect(normaliseProfile({ name: 42, role: ['saver'], language: null, persona: {} })).toEqual(
      DEFAULT_PROFILE
    );
  });

  it('copes with a profile that is not an object at all', () => {
    expect(normaliseProfile('{"name":"Ada"}')).toEqual(DEFAULT_PROFILE);
    expect(normaliseProfile(null)).toEqual(DEFAULT_PROFILE);
    expect(normaliseProfile(undefined)).toEqual(DEFAULT_PROFILE);
    expect(normaliseProfile(7)).toEqual(DEFAULT_PROFILE);
  });
});

describe('the name field', () => {
  it('accepts a name at the bound and rejects one past it', () => {
    const atLimit = 'a'.repeat(MAX_NAME_LENGTH);

    expect(nameProblem(atLimit)).toBeNull();
    expect(nameProblem(`${atLimit}a`)).toBe(`Use ${MAX_NAME_LENGTH} characters or fewer.`);
  });

  it('truncates an over-long name instead of storing it', () => {
    const atLimit = 'a'.repeat(MAX_NAME_LENGTH);

    expect(normaliseProfile({ name: `${atLimit} and then some` }).name).toBe(atLimit);
  });

  it('counts code points, so a name written in emoji is not cut in half', () => {
    const faces = '\u{1F642}'.repeat(MAX_NAME_LENGTH);

    expect(nameProblem(faces)).toBeNull();
    expect(normaliseProfile({ name: `${faces}\u{1F642}` }).name).toBe(faces);
  });

  it('strips control characters, so a name cannot fake a second line in a log', () => {
    expect(normaliseProfile({ name: 'Ada\r\nJailed: 3000' }).name).toBe('Ada Jailed: 3000');
    expect(normaliseProfile({ name: 'Ada ' }).name).toBe('Ada');
  });

  it('trims and collapses whitespace', () => {
    expect(normaliseProfile({ name: '   Ada   Lovelace  ' }).name).toBe('Ada Lovelace');
  });
});

describe('replaceProfile', () => {
  it('stores all four fields, including the ones the user cleared', async () => {
    await saveProfile({ name: 'Ada', role: 'trader', language: 'Igbo' });

    const stored = await replaceProfile({
      name: '',
      language: 'Yoruba',
      persona: 'witty and fun',
      role: '',
    });

    expect(stored).toEqual({ name: '', language: 'Yoruba', persona: 'witty and fun', role: '' });
    // Cleared fields read back as unanswered rather than as the old value.
    expect(await loadProfile()).toEqual({ language: 'Yoruba', persona: 'witty and fun' });
  });

  it('writes the same object the web wallet writes, so either client can read it', async () => {
    await replaceProfile({ name: 'Ada', language: 'English', persona: '', role: 'saver' });

    expect(JSON.parse((await AsyncStorage.getItem(PROFILE_STORAGE_KEY)) ?? '{}')).toEqual({
      name: 'Ada',
      language: 'English',
      persona: '',
      role: 'saver',
    });
  });

  it('validates on the way in, so an unrecognised value cannot reach storage', async () => {
    await replaceProfile({
      name: 'Ada',
      language: 'Klingon',
      persona: 'sarcastic',
      role: 'whale',
    });

    expect(await loadProfile()).toEqual({ name: 'Ada', language: 'English' });
  });
});

describe('resetProfile', () => {
  it('removes the profile rather than blanking it, so the agent re-onboards', async () => {
    await replaceProfile({ name: 'Ada', language: 'Igbo', persona: '', role: 'saver' });

    await resetProfile();

    expect(await AsyncStorage.getItem(PROFILE_STORAGE_KEY)).toBeNull();
    expect(await loadProfile()).toEqual({});
  });

  it('is a no-op when there is nothing stored', async () => {
    await expect(resetProfile()).resolves.toBeUndefined();
  });
});

describe('surviving a restart', () => {
  it('reads every field back once the module is loaded fresh', async () => {
    await replaceProfile({
      name: 'Ada Lovelace',
      language: 'Yoruba',
      persona: 'concise and direct',
      role: 'investor',
    });

    // A relaunch drops every bit of in-process state. Anything still held in a
    // module variable is gone, so only what reached storage can come back.
    jest.resetModules();
    const relaunched: AgentProfileModule = require('../agentProfile');

    expect(relaunched.normaliseProfile(await relaunched.loadProfile())).toEqual({
      name: 'Ada Lovelace',
      language: 'Yoruba',
      persona: 'concise and direct',
      role: 'investor',
    });
  });

  it('repairs a profile the web wallet wrote with values this app does not offer', async () => {
    await AsyncStorage.setItem(
      PROFILE_STORAGE_KEY,
      JSON.stringify({ name: 'Ada', role: 'whale', language: 'Klingon', persona: 'sarcastic' })
    );

    jest.resetModules();
    const relaunched: AgentProfileModule = require('../agentProfile');

    expect(await relaunched.loadProfile()).toEqual({ name: 'Ada', language: 'English' });
  });
});

describe('where the profile is allowed to go', () => {
  it('writes to its own storage key and nowhere else', async () => {
    const setItem = AsyncStorage.setItem as unknown as jest.Mock;
    setItem.mockClear();

    await replaceProfile({ name: 'Ada', language: 'Igbo', persona: '', role: 'saver' });

    expect(setItem.mock.calls.map(([key]) => key)).toEqual([PROFILE_STORAGE_KEY]);
  });

  it('never prints the name to a log', async () => {
    const levels = ['log', 'info', 'warn', 'error'] as const;
    const spies = levels.map((level) =>
      jest.spyOn(console, level).mockImplementation(() => undefined)
    );

    try {
      await replaceProfile({ name: 'Ada Lovelace', language: 'Igbo', persona: '', role: 'saver' });
      await loadProfile();
      await resetProfile();
    } finally {
      jest.restoreAllMocks();
    }

    for (const spy of spies) {
      const printed = spy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
      expect(printed).not.toContain('Ada Lovelace');
    }
  });
});
