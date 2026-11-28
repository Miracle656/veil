import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  areAllSwitchableCategoriesOff,
  configureNotificationSyncForTests,
  DEFAULT_NOTIFICATION_CATEGORIES,
  getLastNotificationSync,
  getNotifIncoming,
  getNotifOutgoing,
  getNotificationCategories,
  getNotificationCategory,
  getNotificationPrivacyFacts,
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
import { ensurePushRegistration, resetPushTokenCacheForTests } from '../pushToken';

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(async () => ({ granted: true })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: 'ExponentPushToken[fixture01Token]' })),
}));

const TOKEN = 'ExponentPushToken[fixture01Token]';

describe('notificationPrefs (#1287)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    configureNotificationSyncForTests({});
    resetNotifPrefsMemoryForTests();
    resetPushTokenCacheForTests();
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

      await setNotificationCategory('activity', false);
      expect(getNotifIncoming()).toBe(false);
      expect(getNotifOutgoing()).toBe(false);

      // Re-enabling Activity restores the stored incoming/outgoing sub-choices.
      await setNotificationCategory('activity', true);
      expect(getNotifIncoming()).toBe(true);
      expect(getNotifOutgoing()).toBe(true);
    });
  });

  describe('persistence across restarts', () => {
    it('survives a cold restart with the user’s chosen categories intact', async () => {
      await setNotificationCategory('seasonal', true);
      await setNotificationCategory('product', false);

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

  describe('EXPO_PUBLIC_REMOTE_PUSH default-off gating and lib/pushToken ownership', () => {
    it('returns disabled without fetching a token or calling /push/devices when remote push flag is off (the default)', async () => {
      const fetchImpl = jest.fn();
      const getToken = jest.fn(async () => TOKEN);

      const { sync } = await setNotificationCategory('seasonal', true, {
        platform: 'android',
        wraithUrl: 'https://wraith.example',
        fetchImpl,
        getToken,
      });

      expect(sync).toEqual({ status: 'disabled' });
      expect(getLastNotificationSync()).toEqual({ status: 'disabled' });
      expect(getToken).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('takes the push token owned by lib/pushToken.ts when remote push is enabled', async () => {
      const register = jest.fn(async () => true);
      await ensurePushRegistration({
        platform: 'android',
        requestPermission: async () => true,
        remotePushEnabled: () => true,
        projectId: () => 'proj-1',
        getToken: async () => TOKEN,
        register,
        metadata: () => ({ appVersion: '1.4.0', locale: 'en-NG' }),
      });

      const fetchImpl = jest.fn(async () => ({ ok: true, status: 200 }) as Response);
      const { sync } = await setNotificationCategory('seasonal', true, {
        platform: 'android',
        remotePushEnabled: () => true,
        wraithUrl: 'https://wraith.example',
        fetchImpl,
        getInstallId: async () => '00000000000000000000000000000001',
        metadata: () => ({ appVersion: '1.4.0', locale: 'en-NG' }),
      });

      expect(sync).toEqual({ status: 'synced', token: TOKEN });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('describes client behaviour accurately without promising unshipped server behaviour', () => {
      const offFacts = getNotificationPrivacyFacts(false);
      const canSeeOff = offFacts.canSee.map((f) => `${f.claim} ${f.detail}`).join(' ');
      expect(canSeeOff).toContain('Remote push is off');
      expect(canSeeOff).not.toContain('filtered out before anything is sent');

      const cannotSee = offFacts.cannotSee.map((f) => `${f.claim} ${f.detail}`).join(' ');
      expect(cannotSee).toContain('This app never includes your wallet address');
      expect(cannotSee).not.toContain('Remote push payloads never carry');
    });
  });

  describe('server install-record sync and deregister-on-all-off (when remote push is enabled)', () => {
    function syncRig() {
      const fetchImpl = jest.fn(async () => ({ ok: true, status: 200 }) as Response);
      const report = jest.fn();
      const deps = {
        platform: 'android',
        remotePushEnabled: () => true,
        wraithUrl: 'https://wraith.example',
        fetchImpl,
        getToken: async () => TOKEN,
        getInstallId: async () => '00000000000000000000000000000001',
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
        installId: '00000000000000000000000000000001',
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

    it('deregisters the push token via DELETE /push/devices/:token when every switchable category is turned off and server confirms 2xx', async () => {
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
        { method: 'DELETE' },
      );
      expect(await AsyncStorage.getItem(NOTIF_REGISTERED_TOKEN_KEY)).toBeNull();

      // Opting back into any category re-registers the device row cleanly.
      fetchImpl.mockClear();
      const third = await setNotificationCategory('seasonal', true, deps);
      expect(third.sync).toEqual({ status: 'synced', token: TOKEN });
      expect(fetchImpl).toHaveBeenCalledWith(
        'https://wraith.example/push/devices',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('does NOT treat HTTP 404 on DELETE as success and keeps the stored token until confirmed', async () => {
      await AsyncStorage.setItem(NOTIF_REGISTERED_TOKEN_KEY, TOKEN);
      const report = jest.fn();
      const fetchImpl = jest.fn(async () => ({ ok: false, status: 404 }) as Response);

      const result = await syncNotificationPrefsToServer(
        { activity: false, security: true, product: false, seasonal: false },
        {
          platform: 'ios',
          remotePushEnabled: () => true,
          wraithUrl: 'https://wraith.example',
          fetchImpl,
          getToken: async () => TOKEN,
          report,
        },
      );

      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.reason).toContain('404');
        expect(result.reason).not.toContain(TOKEN);
        expect(result.reason).toContain(redactPushToken(TOKEN));
      }
      expect(await AsyncStorage.getItem(NOTIF_REGISTERED_TOKEN_KEY)).toBe(TOKEN);
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
