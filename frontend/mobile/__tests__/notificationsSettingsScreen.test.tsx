/**
 * #1287 — the Notifications settings screen's contract with the user.
 *
 * Verifies:
 *  - all four categories render with honest defaults (Seasonal off, Security
 *    locked "Always on" with no switch to flip off),
 *  - privacy copy states accurately what this app sends/does not send under the
 *    default-off remote-push flag without promising server behaviour,
 *  - "deregistered" is NEVER shown on local switches alone or on a 404/failed
 *    DELETE — only when the server actually confirmed deregistration, and
 *  - sync failures are surfaced visibly instead of being discarded.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import NotificationsSettingsScreen from '../app/settings/notifications';
import {
  configureNotificationSyncForTests,
  hydrateNotifPrefs,
  resetNotifPrefsMemoryForTests,
} from '../lib/notificationPrefs';
import { resetPushTokenCacheForTests } from '../lib/pushToken';

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(async () => ({ granted: true })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: 'ExponentPushToken[fixture02Token]' })),
  addPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), canGoBack: () => true, replace: jest.fn() }),
}));

jest.mock('react-native-safe-area-context', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#000000' }) }),
}));

jest.mock('../lib/notifications', () => ({
  requestNotificationPermissions: jest.fn(async () => true),
}));

type Instance = { props: Record<string, unknown>; children: (Instance | string)[] };
type TestNode = Instance & {
  findByProps: (p: object) => Instance;
  findAllByProps: (p: object) => Instance[];
};
type Tree = { root: TestNode; unmount: () => void };
type Renderer = {
  act: (fn: () => Promise<void>) => Promise<void>;
  create: (el: unknown) => Tree;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer: Renderer = require('react-test-renderer');

function text(node: Instance): string {
  return node.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
}

const trees: Tree[] = [];

async function render() {
  let tree!: Tree;
  await renderer.act(async () => {
    tree = renderer.create(<NotificationsSettingsScreen />);
  });
  trees.push(tree);
  return tree;
}

const TOKEN = 'ExponentPushToken[fixture02Token]';

describe('NotificationsSettingsScreen (#1287)', () => {
  const fetchImpl = jest.fn(async () => ({ ok: true, status: 200 }) as Response);
  const report = jest.fn();

  beforeEach(async () => {
    await AsyncStorage.clear();
    fetchImpl.mockReset();
    fetchImpl.mockResolvedValue({ ok: true, status: 200 } as Response);
    report.mockReset();
    configureNotificationSyncForTests({});
    resetNotifPrefsMemoryForTests();
    resetPushTokenCacheForTests();
    await hydrateNotifPrefs();
  });

  afterEach(async () => {
    while (trees.length > 0) {
      const t = trees.pop();
      await renderer.act(async () => {
        t?.unmount();
      });
    }
    configureNotificationSyncForTests({});
  });

  it('shows four categories with Seasonal off by default and Security locked Always on', async () => {
    const { root } = await render();

    expect(root.findByProps({ testID: 'notif-switch-activity' }).props.value).toBe(true);
    expect(root.findByProps({ testID: 'notif-switch-product' }).props.value).toBe(true);
    expect(root.findByProps({ testID: 'notif-switch-seasonal' }).props.value).toBe(false);

    // Security renders an explicit "Always on" badge and exposes no switch to flip off.
    expect(text(root.findByProps({ testID: 'notif-security-locked-badge' }))).toBe('Always on');
    expect(root.findAllByProps({ testID: 'notif-switch-security' })).toHaveLength(0);
    const securityRow = root.findByProps({ testID: 'notif-category-security' });
    expect(securityRow.props.accessibilityState).toEqual({ disabled: true, checked: true });
  });

  it('states honestly what this app sends and never sends when remote push is off by default', async () => {
    const { root } = await render();

    const canSee = text(root.findByProps({ testID: 'notif-what-we-can-see' }));
    expect(canSee).toContain('Remote push is off');
    expect(canSee).toContain('random install ID');
    expect(canSee).not.toContain('filtered out before anything is sent');

    const cannotSee = text(root.findByProps({ testID: 'notif-what-we-cannot-see' }));
    expect(cannotSee).toContain('This app never includes your wallet address');
    expect(cannotSee).not.toContain('Remote push payloads never carry');
  });

  it('does NOT claim "deregistered" when remote push is off and all switchable categories are turned off', async () => {
    configureNotificationSyncForTests({
      platform: 'android',
      wraithUrl: 'https://wraith.example',
      fetchImpl,
      getToken: async () => TOKEN,
    });
    const { root } = await render();

    await renderer.act(async () => {
      (root.findByProps({ testID: 'notif-switch-activity' }).props.onValueChange as (v: boolean) => void)(
        false,
      );
    });
    await renderer.act(async () => {
      (root.findByProps({ testID: 'notif-switch-product' }).props.onValueChange as (v: boolean) => void)(
        false,
      );
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(root.findAllByProps({ testID: 'notif-deregistered-hint' })).toHaveLength(0);
    expect(text(root.findByProps({ testID: 'notif-all-off-local-hint' }))).toContain(
      'Remote push is off in this build',
    );
  });

  it('shows confirmed deregistration ONLY when remote push is enabled and DELETE succeeds (2xx)', async () => {
    configureNotificationSyncForTests({
      platform: 'android',
      remotePushEnabled: () => true,
      wraithUrl: 'https://wraith.example',
      fetchImpl,
      getToken: async () => TOKEN,
      getInstallId: async () => '00000000000000000000000000000002',
      metadata: () => ({ appVersion: '1.0.0', locale: 'en-US' }),
      report,
    });
    const { root } = await render();

    await renderer.act(async () => {
      (root.findByProps({ testID: 'notif-switch-activity' }).props.onValueChange as (v: boolean) => void)(
        false,
      );
    });
    await renderer.act(async () => {
      (root.findByProps({ testID: 'notif-switch-product' }).props.onValueChange as (v: boolean) => void)(
        false,
      );
    });

    expect(fetchImpl).toHaveBeenLastCalledWith(
      `https://wraith.example/push/devices/${encodeURIComponent(TOKEN)}`,
      { method: 'DELETE' },
    );
    expect(text(root.findByProps({ testID: 'notif-deregistered-hint' }))).toContain(
      'server confirmed',
    );
    expect(root.findAllByProps({ testID: 'notif-sync-error' })).toHaveLength(0);
  });

  it('surfaces sync failure and does NOT show "deregistered" when DELETE returns 404', async () => {
    fetchImpl
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response);

    configureNotificationSyncForTests({
      platform: 'android',
      remotePushEnabled: () => true,
      wraithUrl: 'https://wraith.example',
      fetchImpl,
      getToken: async () => TOKEN,
      getInstallId: async () => '00000000000000000000000000000002',
      metadata: () => ({ appVersion: '1.0.0', locale: 'en-US' }),
      report,
    });
    const { root } = await render();

    await renderer.act(async () => {
      (root.findByProps({ testID: 'notif-switch-activity' }).props.onValueChange as (v: boolean) => void)(
        false,
      );
    });
    await renderer.act(async () => {
      (root.findByProps({ testID: 'notif-switch-product' }).props.onValueChange as (v: boolean) => void)(
        false,
      );
    });

    expect(root.findAllByProps({ testID: 'notif-deregistered-hint' })).toHaveLength(0);
    const errorText = text(root.findByProps({ testID: 'notif-sync-error' }));
    expect(errorText).toContain('server did not confirm');
    expect(errorText).toContain('404');
    expect(errorText).not.toContain(TOKEN);
  });
});
