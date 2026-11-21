/**
 * #1287 — the Notifications settings screen's contract with the user.
 *
 * Verifies the screen renders all four categories with their honest defaults
 * (Seasonal off, Security locked "Always on" with no switch to toggle off),
 * states plainly what Veil can and cannot see, and deregisters the server push
 * token when every switchable category is turned off.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import NotificationsSettingsScreen from '../app/settings/notifications';
import {
  configureNotificationSyncForTests,
  hydrateNotifPrefs,
  resetNotifPrefsMemoryForTests,
} from '../lib/notificationPrefs';

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

async function render() {
  let tree!: Tree;
  await renderer.act(async () => {
    tree = renderer.create(<NotificationsSettingsScreen />);
  });
  return tree;
}

const TOKEN = 'ExponentPushToken[screenTestToken1234]';

describe('NotificationsSettingsScreen (#1287)', () => {
  const fetchImpl = jest.fn(async () => ({ ok: true, status: 200 }) as Response);

  beforeEach(async () => {
    await AsyncStorage.clear();
    fetchImpl.mockClear();
    configureNotificationSyncForTests({
      platform: 'android',
      wraithUrl: 'https://wraith.example',
      fetchImpl,
      getToken: async () => TOKEN,
      getInstallId: async () => 'abcdef0123456789abcdef0123456789',
      metadata: () => ({ appVersion: '1.0.0', locale: 'en-US' }),
    });
    resetNotifPrefsMemoryForTests();
    await hydrateNotifPrefs();
  });

  afterEach(() => {
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

  it('states plainly what Veil can and cannot see on the same screen', async () => {
    const { root } = await render();

    const canSee = text(root.findByProps({ testID: 'notif-what-we-can-see' }));
    expect(canSee).toContain('random install ID');
    expect(canSee).toContain('four category switches');

    const cannotSee = text(root.findByProps({ testID: 'notif-what-we-cannot-see' }));
    expect(cannotSee).toContain('wallet address');
    expect(cannotSee).toContain('never sent to the push registry');
    expect(cannotSee).toContain('balances');
  });

  it('deregisters the push token when Activity and Product are switched off alongside Seasonal', async () => {
    const { root } = await render();

    await renderer.act(async () => {
      (root.findByProps({ testID: 'notif-switch-activity' }).props.onValueChange as (v: boolean) => void)(
        false
      );
    });
    await renderer.act(async () => {
      (root.findByProps({ testID: 'notif-switch-product' }).props.onValueChange as (v: boolean) => void)(
        false
      );
    });

    expect(fetchImpl).toHaveBeenLastCalledWith(
      `https://wraith.example/push/devices/${encodeURIComponent(TOKEN)}`,
      { method: 'DELETE' }
    );
    expect(text(root.findByProps({ testID: 'notif-deregistered-hint' }))).toContain('deregistered');
  });
});
