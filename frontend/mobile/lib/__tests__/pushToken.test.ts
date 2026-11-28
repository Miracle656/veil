import * as Notifications from 'expo-notifications';

import {
  ensurePushRegistration,
  isRemotePushEnabled,
  redactPushToken,
  registerPushDevice,
  registerRotatedToken,
  resolveProjectId,
  watchPushTokenRotation,
  type PushRegistrationDeps,
} from '../pushToken';

jest.mock('expo-notifications', () => ({
  getExpoPushTokenAsync: jest.fn(),
  addPushTokenListener: jest.fn(),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
}));

const TOKEN = 'ExponentPushToken[abcdEFGHijklMNOPqrstUV]';

/** Dependencies for a run where everything works; each test overrides one thing. */
function happy(overrides: PushRegistrationDeps = {}) {
  const report = jest.fn();
  const register = jest.fn(async () => true);
  const getToken = jest.fn(async () => TOKEN);
  const deps: PushRegistrationDeps = {
    platform: 'android',
    requestPermission: async () => true,
    remotePushEnabled: () => true,
    projectId: () => 'project-id',
    getToken,
    register,
    metadata: () => ({ appVersion: '1.2.3', locale: 'en-NG' }),
    report,
    ...overrides,
  };
  return { deps, report, register, getToken };
}

describe('resolveProjectId', () => {
  it('reads the id app.config.ts puts under extra.eas', () => {
    expect(resolveProjectId({ expoConfig: { extra: { eas: { projectId: 'from-extra' } } } })).toBe(
      'from-extra',
    );
  });

  it('falls back to the id EAS Build injects', () => {
    expect(resolveProjectId({ expoConfig: { extra: {} }, easConfig: { projectId: 'from-eas' } })).toBe(
      'from-eas',
    );
  });

  it('returns null, not a throw, when the build has neither (Expo Go, local builds)', () => {
    expect(resolveProjectId({})).toBeNull();
    expect(resolveProjectId({ expoConfig: null, easConfig: null })).toBeNull();
    expect(resolveProjectId({ expoConfig: { extra: { eas: { projectId: '  ' } } } })).toBeNull();
  });
});

describe('isRemotePushEnabled', () => {
  it('is off when the build does not set the flag', () => {
    expect(isRemotePushEnabled(undefined)).toBe(false);
    expect(isRemotePushEnabled('')).toBe(false);
  });

  it('is on only for an explicit 1 or true', () => {
    expect(isRemotePushEnabled('1')).toBe(true);
    expect(isRemotePushEnabled('true')).toBe(true);
    expect(isRemotePushEnabled(' TRUE ')).toBe(true);
  });

  it('stays off for anything else, so a typo never enables it', () => {
    for (const value of ['0', 'false', 'yes', 'on', 'ture']) {
      expect(isRemotePushEnabled(value)).toBe(false);
    }
  });
});

describe('ensurePushRegistration', () => {
  it('with remote push off (the default), asks for permission but fetches no token and sends nothing', async () => {
    const requestPermission = jest.fn(async () => true);
    const { deps, getToken, register } = happy({ remotePushEnabled: () => false, requestPermission });

    await expect(ensurePushRegistration(deps)).resolves.toEqual({ status: 'disabled' });
    expect(requestPermission).toHaveBeenCalledTimes(1); // local notifications still need it
    expect(getToken).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('is off by default when the build sets no flag', async () => {
    const { deps, getToken, register } = happy();
    delete deps.remotePushEnabled; // use the real default; the test build sets no flag

    await expect(ensurePushRegistration(deps)).resolves.toEqual({ status: 'disabled' });
    expect(getToken).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('registers the token with platform, version and locale', async () => {
    const { deps, register } = happy();

    await expect(ensurePushRegistration(deps)).resolves.toEqual({ status: 'registered', token: TOKEN });
    expect(register).toHaveBeenCalledWith({
      token: TOKEN,
      platform: 'android',
      appVersion: '1.2.3',
      locale: 'en-NG',
    });
  });

  it('reports a missing projectId instead of throwing, and asks Expo for nothing', async () => {
    const { deps, report, getToken, register } = happy({ projectId: () => null });

    await expect(ensurePushRegistration(deps)).resolves.toEqual({ status: 'no-project-id' });
    expect(report).toHaveBeenCalledWith(expect.stringContaining('no EAS projectId'));
    expect(getToken).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('stops quietly when permission is denied, leaving local notifications alone', async () => {
    const { deps, report, getToken, register } = happy({ requestPermission: async () => false });

    await expect(ensurePushRegistration(deps)).resolves.toEqual({ status: 'denied' });
    expect(getToken).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    // A refusal is the user's choice, not a fault worth logging.
    expect(report).not.toHaveBeenCalled();
  });

  it('does nothing on web, where there is no remote push', async () => {
    const requestPermission = jest.fn(async () => true);
    const { deps } = happy({ platform: 'web', requestPermission });

    await expect(ensurePushRegistration(deps)).resolves.toEqual({ status: 'unsupported' });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('keeps the token but says so when the build has no registry', async () => {
    const { deps } = happy({ register: async () => false });

    await expect(ensurePushRegistration(deps)).resolves.toEqual({ status: 'no-registry', token: TOKEN });
  });

  it.each([
    ['permission check', { requestPermission: async () => Promise.reject(new Error('boom')) }],
    ['push token request', { getToken: async () => Promise.reject(new Error('no FCM')) }],
    ['registering', { register: async () => Promise.reject(new Error('registry answered 500')) }],
  ])('never throws when the %s fails', async (step, override) => {
    const { deps, report } = happy(override as PushRegistrationDeps);

    const result = await ensurePushRegistration(deps);

    expect(result.status).toBe('failed');
    expect(report).toHaveBeenCalledWith(expect.stringContaining(step));
  });

  it('never logs the full token when registration fails', async () => {
    const { deps, report } = happy({ register: async () => Promise.reject(new Error('down')) });

    await ensurePushRegistration(deps);

    const logged = report.mock.calls.flat().join(' ');
    expect(logged).not.toContain(TOKEN);
    expect(logged).toContain('ExponentPushToken[abcd…]');
  });
});

describe('redactPushToken', () => {
  it('keeps the prefix and four characters, enough to tell tokens apart', () => {
    expect(redactPushToken(TOKEN)).toBe('ExponentPushToken[abcd…]');
  });

  it('shortens a token of an unexpected shape too', () => {
    expect(redactPushToken('abcdefgh')).toBe('abcd…');
    expect(redactPushToken('ab')).toBe('…');
  });
});

describe('registerPushDevice', () => {
  const registration = { token: TOKEN, platform: 'ios' as const, appVersion: '1.0.0', locale: 'en' };

  it('upserts the device with POST /push/devices', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200 }) as Response);

    await expect(
      registerPushDevice(registration, { wraithUrl: 'https://wraith.example', fetchImpl }),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith('https://wraith.example/push/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registration),
    });
  });

  it('returns false without a request when no registry is configured', async () => {
    const fetchImpl = jest.fn();

    await expect(registerPushDevice(registration, { wraithUrl: null, fetchImpl })).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws when the registry rejects the request', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 503 }) as Response);

    await expect(
      registerPushDevice(registration, { wraithUrl: 'https://wraith.example', fetchImpl }),
    ).rejects.toThrow('503');
  });
});

describe('watchPushTokenRotation', () => {
  const addPushTokenListener = Notifications.addPushTokenListener as jest.Mock;

  beforeEach(() => addPushTokenListener.mockReset());

  type Listener = (event: { data: string }) => void;
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('re-registers every time the OS rotates the token, until unsubscribed', async () => {
    const remove = jest.fn();
    let rotate: Listener | undefined;
    addPushTokenListener.mockImplementation((listener: Listener) => {
      rotate = listener;
      return { remove };
    });
    const onRotate = jest.fn(async () => undefined);

    const stop = watchPushTokenRotation(onRotate, 'ios');
    rotate?.({ data: 'apns-1' });
    rotate?.({ data: 'apns-2' });

    expect(onRotate).toHaveBeenNthCalledWith(1, 'apns-1');
    expect(onRotate).toHaveBeenNthCalledWith(2, 'apns-2');
    stop();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('ignores a native token it has already seen', () => {
    let rotate: Listener | undefined;
    addPushTokenListener.mockImplementation((listener: Listener) => {
      rotate = listener;
      return { remove: jest.fn() };
    });
    const onRotate = jest.fn(async () => undefined);

    watchPushTokenRotation(onRotate, 'android');
    rotate?.({ data: 'fcm-1' });
    rotate?.({ data: 'fcm-1' });

    expect(onRotate).toHaveBeenCalledTimes(1);
  });

  it('turns the native token it was handed into an Expo token, without fetching the native one again', async () => {
    let rotate: Listener | undefined;
    addPushTokenListener.mockImplementation((listener: Listener) => {
      rotate = listener;
      return { remove: jest.fn() };
    });
    const getExpoPushTokenAsync = Notifications.getExpoPushTokenAsync as jest.Mock;
    getExpoPushTokenAsync.mockReset().mockResolvedValue({ data: TOKEN });
    const { deps, register } = happy();

    watchPushTokenRotation((t) => registerRotatedToken(t, 'android', deps), 'android');
    rotate?.({ data: 'fcm-1' });
    await flush();

    expect(getExpoPushTokenAsync).toHaveBeenCalledWith({
      projectId: 'project-id',
      devicePushToken: { type: 'android', data: 'fcm-1' },
    });
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ token: TOKEN }));
  });

  it('does not loop when fetching a token fires the listener again', async () => {
    let rotate: Listener | undefined;
    addPushTokenListener.mockImplementation((listener: Listener) => {
      rotate = listener;
      return { remove: jest.fn() };
    });
    // expo-notifications emits onDevicePushToken on every native token fetch.
    const getExpoPushTokenAsync = Notifications.getExpoPushTokenAsync as jest.Mock;
    getExpoPushTokenAsync.mockReset().mockImplementation(async () => {
      rotate?.({ data: 'apns-1' });
      return { data: TOKEN };
    });
    const { deps, register } = happy();

    watchPushTokenRotation((t) => registerRotatedToken(t, 'ios', deps), 'ios');
    rotate?.({ data: 'apns-1' });
    for (let i = 0; i < 5; i++) await flush();

    expect(getExpoPushTokenAsync).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on web', () => {
    const stop = watchPushTokenRotation(jest.fn(), 'web');

    expect(addPushTokenListener).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });
});
