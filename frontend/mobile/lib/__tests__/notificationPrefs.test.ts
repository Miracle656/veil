import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  areAllSwitchableCategoriesOff,
  configureNotificationSyncForTests,
  DEFAULT_NOTIFICATION_CATEGORIES,
  getNotifIncoming,
  getNotifOutgoing,
  getNotificationCategories,
  getNotificationCategory,
  getOrCreateInstallId,
  hydrateNotifPrefs,
  isCategorySwitchable,
  NOTIF_CATEGORY_SECURITY_KEY,
  NOTIF_REGISTERED_TOKEN_KEY,
  redactPushToken,
  resetNotifPrefsMemoryForTests,
  setNotifOutgoing,
  setNotificationCategory,
  syncNotificationPrefsToServer,
} from '../notificationPrefs';

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(async () => ({ granted: true })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: 'ExponentPushToken[abcdEFGHijklMNOPqrstUV]' })),
}));

const TOKEN = 'ExponentPushToken[abcdEFGHijklMNOPqrstUV]';

describe('notificationPrefs (#1287)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    configureNotificationSyncForTests({});
    resetNotifPrefsMemoryForTests();
  });

  describe('defaults and category rules', () => {
    it('defaults Activity=on, Security=on, Product=on, and Seasonal=off until explicitly enabled', async () => {
      await hydrateNotifPrefs();

      expect(getNotificationCategories()).toEqual({
        activity: true,
        security: true,
        product: true,
        seasonal: false,
      });
      expect(DEFAULT_NOTIFICATION_CATEGORIES.seasonal).toBe(false);
      expect(getNotificationCategory('seasonal')).toBe(false);
    });

    it('treats Security as non-switchable and refuses attempts to turn it off', async () => {
      expect(isCategorySwitchable('security')).toBe(false);
      expect(isCategorySwitchable('activity')).toBe(true);
      expect(isCategorySwitchable('product')).toBe(true);
      expect(isCategorySwitchable('seasonal')).toBe(true);

      await setNotificationCategory('security', false);
      expect(getNotificationCategory('security')).toBe(true);

      // Even if storage is tampered with before a cold launch, Security hydrates on.
      await AsyncStorage.setItem(NOTIF_CATEGORY_SECURITY_KEY, '0');
      resetNotifPrefsMemoryForTests();
      await hydrateNotifPrefs();
      expect(getNotificationCategory('security')).toBe(true);
    });

    it('gates local incoming and outgoing transfer checks behind the Activity category', async () => {
      await hydrateNotifPrefs();
      await setNotifOutgoing(true);
      expect(getNotifIncoming()).toBe(true);
      expect(getNotifOutgoing()).toBe(true);

      await setNotificationCategory('activity', false, { wraithUrl: null });
      expect(getNotifIncoming()).toBe(false);
      expect(getNotifOutgoing()).toBe(false);

      // Re-enabling Activity restores the stored incoming/outgoing sub-choices.
      await setNotificationCategory('activity', true, { wraithUrl: null });
      expect(getNotifIncoming()).toBe(true);
      expect(getNotifOutgoing()).toBe(true);
    });
  });

  describe('persistence across restarts', () => {
    it('survives a cold restart with the user’s chosen categories intact', async () => {
      await setNotificationCategory('seasonal', true, { wraithUrl: null });
      await setNotificationCategory('product', false, { wraithUrl: null });

      resetNotifPrefsMemoryForTests();
      await hydrateNotifPrefs();

      expect(getNotificationCategories()).toEqual({
        activity: true,
        security: true,
        product: false,
        seasonal: true,
      });
    });

    it('generates a random install id once and reuses it across restarts', async () => {
      const first = await getOrCreateInstallId();
      expect(first).toMatch(/^[0-9a-f]{32}$/);

      const second = await getOrCreateInstallId();
      expect(second).toBe(first);
    });
  });

  describe('server install-record sync and deregister-on-all-off', () => {
    function syncRig() {
      const fetchImpl = jest.fn(async () => ({ ok: true, status: 200 }) as Response);
      const report = jest.fn();
      const deps = {
        platform: 'android',
        wraithUrl: 'https://wraith.example',
        fetchImpl,
        getToken: async () => TOKEN,
        getInstallId: async () => '0123456789abcdef0123456789abcdef',
        metadata: () => ({ appVersion: '1.4.0', locale: 'en-NG' }),
        report,
      };
      return { deps, fetchImpl, report };
    }

    it('reflects preference changes server-side without sending wallet-identifying fields', async () => {
      const { deps, fetchImpl } = syncRig();

      const { sync } = await setNotificationCategory('seasonal', true, deps);

      expect(sync).toEqual({ status: 'synced', token: TOKEN });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://wraith.example/push/devices');
      expect(init.method).toBe('POST');

      const body = JSON.parse(String(init.body));
      expect(body).toEqual({
        token: TOKEN,
        installId: '0123456789abcdef0123456789abcdef',
        platform: 'android',
        appVersion: '1.4.0',
        locale: 'en-NG',
        categories: {
          activity: true,
          security: true,
          product: true,
          seasonal: true,
        },
      });
      expect(body.walletAddress).toBeUndefined();
      expect(body.publicKey).toBeUndefined();
      expect(body.passkeyId).toBeUndefined();
    });

    it('deregisters the push token via DELETE /push/devices/:token when every switchable category is turned off', async () => {
      const { deps, fetchImpl } = syncRig();

      // Seasonal starts off. Turn Activity off -> Product is still on -> POST upsert.
      const first = await setNotificationCategory('activity', false, deps);
      expect(first.sync).toEqual({ status: 'synced', token: TOKEN });
      expect(areAllSwitchableCategoriesOff(first.categories)).toBe(false);

      // Now turn Product off -> Activity=false, Product=false, Seasonal=false -> DELETE!
      fetchImpl.mockClear();
      const second = await setNotificationCategory('product', false, deps);

      expect(areAllSwitchableCategoriesOff(second.categories)).toBe(true);
      expect(second.categories.security).toBe(true);
      expect(second.sync).toEqual({ status: 'deregistered', token: TOKEN });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledWith(
        `https://wraith.example/push/devices/${encodeURIComponent(TOKEN)}`,
        { method: 'DELETE' }
      );
      expect(await AsyncStorage.getItem(NOTIF_REGISTERED_TOKEN_KEY)).toBeNull();

      // Opting back into any category re-registers the device row cleanly.
      fetchImpl.mockClear();
      const third = await setNotificationCategory('seasonal', true, deps);
      expect(third.sync).toEqual({ status: 'synced', token: TOKEN });
      expect(fetchImpl).toHaveBeenCalledWith(
        'https://wraith.example/push/devices',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('treats 404 on DELETE as a clean deregistration when the row is already gone', async () => {
      const fetchImpl = jest.fn(async () => ({ ok: false, status: 404 }) as Response);
      const result = await syncNotificationPrefsToServer(
        { activity: false, security: true, product: false, seasonal: false },
        {
          platform: 'ios',
          wraithUrl: 'https://wraith.example',
          fetchImpl,
          getToken: async () => TOKEN,
        }
      );

      expect(result).toEqual({ status: 'deregistered', token: TOKEN });
    });

    it('redacts the push token whenever a sync or deregister failure is reported', async () => {
      const { deps, report } = syncRig();
      deps.fetchImpl = jest.fn(async () => ({ ok: false, status: 503 }) as Response);

      const result = await syncNotificationPrefsToServer(getNotificationCategories(), deps);

      expect(result.status).toBe('failed');
      const logged = report.mock.calls.flat().join(' ');
      expect(logged).not.toContain(TOKEN);
      expect(logged).toContain(redactPushToken(TOKEN));
    });
  });
});
