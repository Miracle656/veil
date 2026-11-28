/**
 * Remote push: the device half (#1273).
 *
 * Makes this install addressable by obtaining an Expo push token and handing it
 * to the device registry in wraith (`POST /push/devices`, #1274). It sends
 * nothing itself — the sender is a separate piece of the notifications epic.
 *
 * Push is an addition to the local notifications in `lib/notifications.ts`,
 * never a replacement. Every failure here — no permission, no EAS project id,
 * no registry configured, the registry unreachable — ends with the app exactly
 * as it was before: local notifications keep working and nothing is thrown.
 *
 * A push token is a capability: anyone holding it can send this device a
 * notification through Expo. It is never logged in full ({@link redactPushToken}).
 *
 * Remote push is OFF unless the build sets `EXPO_PUBLIC_REMOTE_PUSH` to `1` or
 * `true` ({@link isRemotePushEnabled}). Until the registry route (#1274) exists
 * and users are asked separately for remote push, a build without the flag only
 * asks for notification permission (which local notifications need) and never
 * fetches a push token or calls the registry. That keeps people who allowed
 * local payment alerts from being enrolled in remote push without being asked.
 *
 * Push tokens do not exist in Expo Go from SDK 54 onward; this needs a
 * development build or one of the release APKs.
 */

import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { getWraithUrl } from './nfts';
import { requestNotificationPermissions } from './notifications';

/** How a registration attempt ended. Only `registered` means the registry has the token. */
export type PushRegistrationResult =
  | { status: 'registered'; token: string }
  /** Web, or a platform with no remote push. */
  | { status: 'unsupported' }
  /** The user refused, or has not granted, notification permission. */
  | { status: 'denied' }
  /** Remote push is switched off in this build (the default); no token, no request. */
  | { status: 'disabled' }
  /** The build carries no EAS project id (Expo Go, or a build made outside EAS). */
  | { status: 'no-project-id' }
  /** A token was obtained but this build has no registry to give it to. */
  | { status: 'no-registry'; token: string }
  /** Obtaining or registering the token failed; `reason` is safe to log. */
  | { status: 'failed'; reason: string };

/** The registration body agreed in #1274. Keyed to the install, never the wallet. */
export interface PushDeviceRegistration {
  token: string;
  platform: 'ios' | 'android';
  appVersion: string;
  locale: string;
}

/**
 * Whether this build may fetch a push token and register it. Off by default:
 * only an explicit `1` or `true` turns it on, so an unset, empty or mistyped
 * value keeps remote push off.
 */
export function isRemotePushEnabled(
  value: string | undefined = process.env['EXPO_PUBLIC_REMOTE_PUSH'],
): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

type ConstantsLike = {
  expoConfig?: { extra?: { eas?: { projectId?: unknown } } | null; version?: unknown } | null;
  easConfig?: { projectId?: unknown } | null;
};

/**
 * The EAS project id this build was made for, or null when it has none.
 *
 * Read from `expoConfig.extra.eas.projectId` (what `app.config.ts` sets), falling
 * back to `easConfig.projectId` (what EAS Build injects). A missing id is normal
 * in Expo Go and in local builds, so it is a value to report, not a crash.
 */
export function resolveProjectId(constants: ConstantsLike = Constants as ConstantsLike): string | null {
  const fromExtra = constants.expoConfig?.extra?.eas?.projectId;
  if (typeof fromExtra === 'string' && fromExtra.trim()) return fromExtra.trim();
  const fromEas = constants.easConfig?.projectId;
  if (typeof fromEas === 'string' && fromEas.trim()) return fromEas.trim();
  return null;
}

/**
 * A push token shortened for logs: enough to tell two tokens apart, not enough
 * to send with. `ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]` → `ExponentPushToken[xxxx…]`.
 */
export function redactPushToken(token: string): string {
  const match = /^(\w+PushToken)\[(.*)\]$/.exec(token);
  if (match) return `${match[1]}[${match[2].slice(0, 4)}…]`;
  return token.length > 4 ? `${token.slice(0, 4)}…` : '…';
}

/** The app version and locale sent with each registration. */
export function deviceMetadata(): Pick<PushDeviceRegistration, 'appVersion' | 'locale'> {
  const configured = (Constants as ConstantsLike).expoConfig?.version;
  const appVersion =
    Application.nativeApplicationVersion ?? (typeof configured === 'string' ? configured : 'unknown');
  let locale = 'en';
  try {
    locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en';
  } catch {
    // Hermes without Intl: the registry only uses this to pick a language.
  }
  return { appVersion, locale };
}

/**
 * Upsert this install's token in the device registry. Idempotent on the token,
 * so calling it again after a rotation, a relaunch or a retry is always safe.
 *
 * Returns false when the build has no registry configured; throws when one is
 * configured but rejects the request or cannot be reached.
 */
export async function registerPushDevice(
  registration: PushDeviceRegistration,
  options: { wraithUrl?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const base = options.wraithUrl === undefined ? getWraithUrl() : options.wraithUrl;
  if (!base) return false;
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(`${base}/push/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(registration),
  });
  if (!response.ok) throw new Error(`device registry answered ${response.status}`);
  return true;
}

export interface PushRegistrationDeps {
  platform?: string;
  requestPermission?: () => Promise<boolean>;
  remotePushEnabled?: () => boolean;
  projectId?: () => string | null;
  getToken?: (projectId: string) => Promise<string>;
  register?: (registration: PushDeviceRegistration) => Promise<boolean>;
  metadata?: () => Pick<PushDeviceRegistration, 'appVersion' | 'locale'>;
  report?: (message: string) => void;
}

const defaultDeps: Required<PushRegistrationDeps> = {
  platform: Platform.OS,
  requestPermission: requestNotificationPermissions,
  remotePushEnabled: () => isRemotePushEnabled(),
  projectId: () => resolveProjectId(),
  getToken: async (projectId) => (await Notifications.getExpoPushTokenAsync({ projectId })).data,
  register: (registration) => registerPushDevice(registration),
  metadata: deviceMetadata,
  report: (message) => console.warn(`[push] ${message}`),
};

/**
 * Obtain this install's Expo push token and register it. Never throws.
 *
 * Permission goes through the same `requestNotificationPermissions` path the
 * local notifications use, so a user sees one prompt, not two. Callers decide
 * *when*: the issue asks for this only once the user has a wallet.
 */
export async function ensurePushRegistration(
  overrides: PushRegistrationDeps = {},
): Promise<PushRegistrationResult> {
  const deps = { ...defaultDeps, ...overrides };
  if (deps.platform !== 'ios' && deps.platform !== 'android') return { status: 'unsupported' };

  try {
    if (!(await deps.requestPermission())) return { status: 'denied' };
  } catch (err) {
    return failed(deps, 'permission check', err);
  }

  // Permission above is shared with local notifications and is still needed.
  // Everything remote stops here unless the build switched it on.
  if (!deps.remotePushEnabled()) return { status: 'disabled' };

  const projectId = deps.projectId();
  if (!projectId) {
    deps.report('no EAS projectId in this build; remote push is off, local notifications are unaffected');
    return { status: 'no-project-id' };
  }

  let token: string;
  try {
    token = await deps.getToken(projectId);
  } catch (err) {
    return failed(deps, 'push token request', err);
  }

  try {
    const registered = await deps.register({
      token,
      platform: deps.platform,
      ...deps.metadata(),
    });
    return registered ? { status: 'registered', token } : { status: 'no-registry', token };
  } catch (err) {
    return failed(deps, `registering ${redactPushToken(token)}`, err);
  }
}

function failed(
  deps: Required<PushRegistrationDeps>,
  step: string,
  err: unknown,
): PushRegistrationResult {
  const reason = `${step} failed: ${err instanceof Error ? err.message : String(err)}`;
  deps.report(reason);
  return { status: 'failed', reason };
}

/**
 * Register the Expo token for a native token the OS just handed over.
 *
 * Passing `devicePushToken` to `getExpoPushTokenAsync` matters: without it Expo
 * fetches the native token again, and every native fetch fires the push token
 * listener again, so a rotation would re-register in an endless loop.
 */
export function registerRotatedToken(
  devicePushToken: string,
  platform: 'ios' | 'android',
  overrides: PushRegistrationDeps = {},
): Promise<PushRegistrationResult> {
  return ensurePushRegistration({
    ...overrides,
    getToken: async (projectId) =>
      (
        await Notifications.getExpoPushTokenAsync({
          projectId,
          devicePushToken: { type: platform, data: devicePushToken },
        })
      ).data,
  });
}

/**
 * Re-register whenever the OS rotates the device's push credentials.
 *
 * `addPushTokenListener` reports the native (APNs/FCM) token, not the Expo one,
 * so the listener converts it to an Expo token rather than sending it as is.
 * The listener also fires on every native token fetch, not only on a real
 * rotation, so a native token already seen is ignored.
 * Returns the unsubscribe function; a no-op on platforms with no remote push.
 */
export function watchPushTokenRotation(
  onRotate?: (devicePushToken: string) => Promise<unknown>,
  platform: string = Platform.OS,
): () => void {
  if (platform !== 'ios' && platform !== 'android') return () => {};
  const os = platform;
  const handle = onRotate ?? ((devicePushToken: string) => registerRotatedToken(devicePushToken, os));
  let lastSeen: string | null = null;
  const subscription = Notifications.addPushTokenListener(({ data }) => {
    const devicePushToken = String(data);
    if (devicePushToken === lastSeen) return;
    lastSeen = devicePushToken;
    void handle(devicePushToken);
  });
  return () => subscription.remove();
}
