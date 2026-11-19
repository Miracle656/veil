/**
 * Notification preferences and install-scoped server sync (#1287).
 *
 * Four categories, each with its own switch on the Notifications settings
 * screen, except Security, which stays on:
 *
 *   - **activity** (default on): money arriving, or a sent payment confirming.
 *   - **security** (default on, not switchable off): a new passkey registered,
 *     or a dApp granted permission.
 *   - **product**  (default on): a new build is available, or a rail came back up.
 *   - **seasonal** (default off): holiday greetings and milestones — opt-in only.
 *
 * Preferences live in two places:
 *   1. `AsyncStorage` on the device, so local notification checks (`notifications.ts`)
 *      and cold restarts read them immediately.
 *   2. The device registry in wraith (`POST /push/devices` / `DELETE /push/devices/:token`,
 *      #1274), keyed to a random install id and Expo push token — never to a
 *      wallet address, public key, passkey id, or NIN — so filtered broadcasts
 *      are dropped server-side instead of waking the phone for nothing.
 *
 * When every switchable category (`activity`, `product`, `seasonal`) is turned
 * off, the Expo push token is deregistered via `DELETE /push/devices/:token`
 * rather than leaving a dead row in the registry. Local security alerts remain
 * active on the device.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { getWraithUrl } from './nfts';

// ── Keys ─────────────────────────────────────────────────────────────────────

/** AsyncStorage key for the incoming-transfers sub-toggle under Activity. */
export const NOTIF_INCOMING_KEY = 'veil_notif_incoming';

/** AsyncStorage key for the outgoing-confirmations sub-toggle under Activity. */
export const NOTIF_OUTGOING_KEY = 'veil_notif_outgoing';

/** AsyncStorage key for the Activity category toggle. */
export const NOTIF_CATEGORY_ACTIVITY_KEY = 'veil_notif_cat_activity';

/** AsyncStorage key for the Security category (pinned on; persisted for clarity). */
export const NOTIF_CATEGORY_SECURITY_KEY = 'veil_notif_cat_security';

/** AsyncStorage key for the Product category toggle. */
export const NOTIF_CATEGORY_PRODUCT_KEY = 'veil_notif_cat_product';

/** AsyncStorage key for the Seasonal category toggle (off until explicit opt-in). */
export const NOTIF_CATEGORY_SEASONAL_KEY = 'veil_notif_cat_seasonal';

/** Random per-install identifier — never derived from any wallet or credential. */
export const NOTIF_INSTALL_ID_KEY = 'veil_push_install_id';

/** Last push token registered with wraith, kept so all-off can delete it cleanly. */
export const NOTIF_REGISTERED_TOKEN_KEY = 'veil_push_registered_token';

// ── Types & defaults ─────────────────────────────────────────────────────────

export const NOTIFICATION_CATEGORIES = ['activity', 'security', 'product', 'seasonal'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const SWITCHABLE_NOTIFICATION_CATEGORIES = ['activity', 'product', 'seasonal'] as const;
export type SwitchableNotificationCategory = (typeof SWITCHABLE_NOTIFICATION_CATEGORIES)[number];

export interface NotificationCategoryPrefs {
  activity: boolean;
  security: boolean;
  product: boolean;
  seasonal: boolean;
}

export interface NotifPrefs extends NotificationCategoryPrefs {
  incoming: boolean;
  outgoing: boolean;
}

export const DEFAULT_NOTIFICATION_CATEGORIES: Readonly<NotificationCategoryPrefs> = {
  activity: true,
  security: true,
  product: true,
  seasonal: false,
};

const DEFAULT_INCOMING = true;
const DEFAULT_OUTGOING = false;

export type NotificationCategoryMeta = {
  key: NotificationCategory;
  title: string;
  example: string;
  switchable: boolean;
};

export const NOTIFICATION_CATEGORY_META: readonly NotificationCategoryMeta[] = [
  {
    key: 'activity',
    title: 'Activity',
    example: 'Money arriving in your wallet, or an outgoing payment confirmed.',
    switchable: true,
  },
  {
    key: 'security',
    title: 'Security',
    example: 'A new passkey registered, or a dApp granted permission. Always on.',
    switchable: false,
  },
  {
    key: 'product',
    title: 'Product',
    example: 'A new build is available, or a payment rail came back up.',
    switchable: true,
  },
  {
    key: 'seasonal',
    title: 'Seasonal',
    example: 'Rare holiday greetings and milestones — never a prompt to move money.',
    switchable: true,
  },
];

export type NotificationBoundaryFact = {
  key: string;
  claim: string;
  detail: string;
};

/** Plain statement of what the push registry stores for this install (#1274/#1287). */
export const NOTIFICATION_CAN_SEE: readonly NotificationBoundaryFact[] = [
  {
    key: 'install-record',
    claim: 'A random install ID and push token',
    detail:
      'When remote push is enabled, Veil stores a random ID generated on this phone, its Expo push token, OS platform, app version, and locale so messages can reach the device.',
  },
  {
    key: 'category-switches',
    claim: 'Your four category switches',
    detail:
      'Activity, Security, Product, and Seasonal preferences are stored against that install ID so disabled categories are filtered out before anything is sent.',
  },
];

/** Plain statement of what never leaves the phone or enters a push record (#1274/#1276/#1287). */
export const NOTIFICATION_CANNOT_SEE: readonly NotificationBoundaryFact[] = [
  {
    key: 'wallet-identity',
    claim: 'Which wallet is on this phone',
    detail:
      'Your wallet address, public key, passkey credential ID, recovery configuration, and NIN are never sent to the push registry or linked to your push token.',
  },
  {
    key: 'balances-and-amounts',
    claim: 'Your balances, contacts, or lock-screen amounts',
    detail:
      'Remote push payloads never carry balances, addresses, or decimal amounts. Local payment banners are composed on your phone and hide amounts whenever the wallet is locked or hidden-amounts is turned on.',
  },
];

// ── State ────────────────────────────────────────────────────────────────────

let prefs: NotifPrefs = {
  ...DEFAULT_NOTIFICATION_CATEGORIES,
  incoming: DEFAULT_INCOMING,
  outgoing: DEFAULT_OUTGOING,
};
let hydrated = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

// ── Public getters ───────────────────────────────────────────────────────────

/** Snapshot of all four notification category states. */
export function getNotificationCategories(): NotificationCategoryPrefs {
  return {
    activity: prefs.activity,
    security: true,
    product: prefs.product,
    seasonal: prefs.seasonal,
  };
}

/** Whether a single notification category is enabled. Security is always `true`. */
export function getNotificationCategory(category: NotificationCategory): boolean {
  if (category === 'security') return true;
  return prefs[category];
}

/** Whether a category can be switched off by the user. */
export function isCategorySwitchable(category: NotificationCategory): boolean {
  return category !== 'security';
}

/**
 * True when every user-switchable category (`activity`, `product`, `seasonal`)
 * is off — the condition under which the remote push token is deregistered
 * rather than leaving a dead install row (#1287).
 */
export function areAllSwitchableCategoriesOff(
  categories: Pick<NotificationCategoryPrefs, 'activity' | 'product' | 'seasonal'> = prefs
): boolean {
  return !categories.activity && !categories.product && !categories.seasonal;
}

/**
 * Effective incoming-transfer notification flag used by `lib/notifications.ts`.
 * Gated by the `activity` category so turning Activity off silences local
 * incoming transfer alerts immediately.
 */
export function getNotifIncoming(): boolean {
  return prefs.activity && prefs.incoming;
}

/**
 * Effective outgoing-confirmation notification flag used by `lib/notifications.ts`.
 * Gated by the `activity` category so turning Activity off silences local
 * outgoing confirmation alerts immediately.
 */
export function getNotifOutgoing(): boolean {
  return prefs.activity && prefs.outgoing;
}

/** Stored incoming sub-preference independent of whether Activity is paused. */
export function getNotifIncomingSubpref(): boolean {
  return prefs.incoming;
}

/** Stored outgoing sub-preference independent of whether Activity is paused. */
export function getNotifOutgoingSubpref(): boolean {
  return prefs.outgoing;
}

/** Short human summary of enabled categories for the Settings overview row. */
export function summarizeNotificationCategories(
  categories: NotificationCategoryPrefs = getNotificationCategories()
): string {
  const active: string[] = [];
  if (categories.activity) active.push('Activity');
  active.push('Security');
  if (categories.product) active.push('Product');
  if (categories.seasonal) active.push('Seasonal');
  return active.join(', ');
}

/** Whether stored preferences have been read yet. */
export function isNotifPrefsHydrated(): boolean {
  return hydrated;
}

// ── Subscribe ────────────────────────────────────────────────────────────────

/** Subscribe to preference changes. Returns an unsubscribe function. */
export function subscribeToNotifPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ── Hydration ────────────────────────────────────────────────────────────────

let hydration: Promise<NotifPrefs> | null = null;

function parseStoredBool(raw: string | null, fallback: boolean): boolean {
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return fallback;
}

/** Load stored preferences. Idempotent: repeated calls share one read. */
export function hydrateNotifPrefs(): Promise<NotifPrefs> {
  hydration ??= Promise.all([
    AsyncStorage.getItem(NOTIF_INCOMING_KEY).catch(() => null),
    AsyncStorage.getItem(NOTIF_OUTGOING_KEY).catch(() => null),
    AsyncStorage.getItem(NOTIF_CATEGORY_ACTIVITY_KEY).catch(() => null),
    AsyncStorage.getItem(NOTIF_CATEGORY_PRODUCT_KEY).catch(() => null),
    AsyncStorage.getItem(NOTIF_CATEGORY_SEASONAL_KEY).catch(() => null),
  ]).then(([storedIncoming, storedOutgoing, storedActivity, storedProduct, storedSeasonal]) => {
    prefs = {
      activity: parseStoredBool(storedActivity, DEFAULT_NOTIFICATION_CATEGORIES.activity),
      // Security is never switchable off, even if storage held a stale '0'.
      security: true,
      product: parseStoredBool(storedProduct, DEFAULT_NOTIFICATION_CATEGORIES.product),
      seasonal: parseStoredBool(storedSeasonal, DEFAULT_NOTIFICATION_CATEGORIES.seasonal),
      incoming: parseStoredBool(storedIncoming, DEFAULT_INCOMING),
      outgoing: parseStoredBool(storedOutgoing, DEFAULT_OUTGOING),
    };
    hydrated = true;
    notify();
    return prefs;
  });
  return hydration;
}

// Start reading at import so preferences are in place before the first poll.
void hydrateNotifPrefs();

// ── Server install-record sync (#1274 / #1287) ───────────────────────────────

type ConstantsLike = {
  expoConfig?: { extra?: { eas?: { projectId?: unknown } } | null; version?: unknown } | null;
  easConfig?: { projectId?: unknown } | null;
};

/** Shorten a push token before logging so logs never leak a send capability. */
export function redactPushToken(token: string): string {
  const match = /^(\w+PushToken)\[(.*)\]$/.exec(token);
  if (match) return `${match[1]}[${match[2].slice(0, 4)}…]`;
  return token.length > 4 ? `${token.slice(0, 4)}…` : '…';
}

function resolveEasProjectId(constants: ConstantsLike = Constants as ConstantsLike): string | null {
  const fromExtra = constants.expoConfig?.extra?.eas?.projectId;
  if (typeof fromExtra === 'string' && fromExtra.trim()) return fromExtra.trim();
  const fromEas = constants.easConfig?.projectId;
  if (typeof fromEas === 'string' && fromEas.trim()) return fromEas.trim();
  return null;
}

function randomHexBytes(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  const cryptoObj = (globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array } })
    .crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < byteLength; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Return this install's random identifier, generating and persisting one on
 * first call. Never derived from a wallet address, public key, or passkey.
 */
export async function getOrCreateInstallId(): Promise<string> {
  const existing = await AsyncStorage.getItem(NOTIF_INSTALL_ID_KEY).catch(() => null);
  if (existing && existing.trim()) return existing.trim();
  const created = randomHexBytes(16);
  await AsyncStorage.setItem(NOTIF_INSTALL_ID_KEY, created).catch(() => undefined);
  return created;
}

function readDeviceMetadata(): { appVersion: string; locale: string } {
  const configured = (Constants as ConstantsLike).expoConfig?.version;
  const appVersion =
    Application.nativeApplicationVersion ??
    (typeof configured === 'string' && configured ? configured : 'unknown');
  let locale = 'en';
  try {
    locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en';
  } catch {
    // Hermes environments without Intl keep 'en'.
  }
  return { appVersion, locale };
}

async function resolveExistingPushToken(): Promise<string | null> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    const perm = (await Notifications.getPermissionsAsync()) as { granted?: boolean } | undefined;
    if (perm?.granted) {
      const projectId = resolveEasProjectId();
      if (projectId) {
        const result = await Notifications.getExpoPushTokenAsync({ projectId });
        if (result?.data) return result.data;
      }
    }
  } catch {
    // Fall back to any previously registered token so DELETE still cleans up.
  }
  const cached = await AsyncStorage.getItem(NOTIF_REGISTERED_TOKEN_KEY).catch(() => null);
  return cached && cached.trim() ? cached.trim() : null;
}

export type NotificationServerSyncResult =
  | { status: 'synced'; token: string }
  | { status: 'deregistered'; token: string }
  | { status: 'unsupported' }
  | { status: 'no-registry' }
  | { status: 'no-token' }
  | { status: 'failed'; reason: string };

export interface NotificationSyncDeps {
  platform?: string;
  wraithUrl?: string | null;
  fetchImpl?: typeof fetch;
  getToken?: () => Promise<string | null>;
  getInstallId?: () => Promise<string>;
  metadata?: () => { appVersion: string; locale: string };
  report?: (message: string) => void;
}

let configuredSyncDeps: NotificationSyncDeps = {};

/** Override server-sync dependencies in tests; pass `{}` to restore defaults. */
export function configureNotificationSyncForTests(deps: NotificationSyncDeps): void {
  configuredSyncDeps = deps;
}

/**
 * Reflect `categories` onto the install record in wraith (#1274 / #1287).
 *
 * - When every switchable category is off (`areAllSwitchableCategoriesOff`),
 *   deletes the token via `DELETE /push/devices/:token` so no dead row remains.
 * - Otherwise upserts `POST /push/devices` with `{ token, installId, platform,
 *   appVersion, locale, categories }` (with `security` always `true`).
 */
export async function syncNotificationPrefsToServer(
  categories: NotificationCategoryPrefs = getNotificationCategories(),
  overrides: NotificationSyncDeps = {}
): Promise<NotificationServerSyncResult> {
  const merged = { ...configuredSyncDeps, ...overrides };
  const platform = merged.platform ?? Platform.OS;
  if (platform !== 'ios' && platform !== 'android') {
    return { status: 'unsupported' };
  }

  const base = merged.wraithUrl === undefined ? getWraithUrl() : merged.wraithUrl;
  if (!base) {
    return { status: 'no-registry' };
  }

  const report = merged.report ?? ((msg: string) => console.warn(`[push-prefs] ${msg}`));
  const doFetch = merged.fetchImpl ?? fetch;
  const normalizedBase = base.replace(/\/+$/, '');

  let token: string | null = null;
  try {
    token = await (merged.getToken ?? resolveExistingPushToken)();
  } catch (err) {
    const reason = `resolving push token failed: ${err instanceof Error ? err.message : String(err)}`;
    report(reason);
    return { status: 'failed', reason };
  }

  if (!token) {
    return { status: 'no-token' };
  }

  if (areAllSwitchableCategoriesOff(categories)) {
    try {
      const response = await doFetch(
        `${normalizedBase}/push/devices/${encodeURIComponent(token)}`,
        { method: 'DELETE' }
      );
      if (!response.ok && response.status !== 404) {
        throw new Error(`device registry answered ${response.status}`);
      }
      await AsyncStorage.removeItem(NOTIF_REGISTERED_TOKEN_KEY).catch(() => undefined);
      return { status: 'deregistered', token };
    } catch (err) {
      const reason = `deregistering ${redactPushToken(token)} failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      report(reason);
      return { status: 'failed', reason };
    }
  }

  try {
    const installId = await (merged.getInstallId ?? getOrCreateInstallId)();
    const { appVersion, locale } = (merged.metadata ?? readDeviceMetadata)();
    const payload = {
      token,
      installId,
      platform,
      appVersion,
      locale,
      categories: {
        activity: categories.activity,
        security: true,
        product: categories.product,
        seasonal: categories.seasonal,
      },
    };
    const response = await doFetch(`${normalizedBase}/push/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`device registry answered ${response.status}`);
    }
    await AsyncStorage.setItem(NOTIF_REGISTERED_TOKEN_KEY, token).catch(() => undefined);
    return { status: 'synced', token };
  } catch (err) {
    const reason = `syncing ${redactPushToken(token)} failed: ${
      err instanceof Error ? err.message : String(err)
    }`;
    report(reason);
    return { status: 'failed', reason };
  }
}

// ── Mutations ────────────────────────────────────────────────────────────────

function update(next: NotifPrefs): void {
  const normalized: NotifPrefs = { ...next, security: true };
  prefs = normalized;
  hydrated = true;
  hydration = Promise.resolve(normalized);
  notify();
}

const CATEGORY_STORAGE_KEYS: Record<NotificationCategory, string> = {
  activity: NOTIF_CATEGORY_ACTIVITY_KEY,
  security: NOTIF_CATEGORY_SECURITY_KEY,
  product: NOTIF_CATEGORY_PRODUCT_KEY,
  seasonal: NOTIF_CATEGORY_SEASONAL_KEY,
};

/**
 * Set a notification category preference, persist it on the device, and reflect
 * the updated category set to the server install record.
 *
 * `security` cannot be switched off: passing `('security', false)` leaves
 * `security` enabled and returns the unchanged category snapshot.
 */
export async function setNotificationCategory(
  category: NotificationCategory,
  enabled: boolean,
  syncOverrides?: NotificationSyncDeps
): Promise<{ categories: NotificationCategoryPrefs; sync: NotificationServerSyncResult }> {
  await hydrateNotifPrefs();

  if (category === 'security') {
    await AsyncStorage.setItem(NOTIF_CATEGORY_SECURITY_KEY, '1');
    const categories = getNotificationCategories();
    return { categories, sync: { status: 'no-registry' } };
  }

  const next: NotifPrefs = {
    ...prefs,
    [category]: enabled,
    security: true,
  };
  update(next);
  await AsyncStorage.setItem(CATEGORY_STORAGE_KEYS[category], enabled ? '1' : '0');

  const categories = getNotificationCategories();
  const sync = await syncNotificationPrefsToServer(categories, syncOverrides);
  return { categories, sync };
}

/** Toggle incoming-transfer local notifications (under Activity). */
export async function setNotifIncoming(enabled: boolean): Promise<void> {
  await hydrateNotifPrefs();
  update({ ...prefs, incoming: enabled });
  await AsyncStorage.setItem(NOTIF_INCOMING_KEY, enabled ? '1' : '0');
}

/** Toggle outgoing-confirmation local notifications (under Activity). */
export async function setNotifOutgoing(enabled: boolean): Promise<void> {
  await hydrateNotifPrefs();
  update({ ...prefs, outgoing: enabled });
  await AsyncStorage.setItem(NOTIF_OUTGOING_KEY, enabled ? '1' : '0');
}

/**
 * Reset in-memory hydration cache so tests can simulate a cold app restart
 * against whatever keys currently sit in `AsyncStorage`.
 */
export function resetNotifPrefsMemoryForTests(): void {
  prefs = {
    ...DEFAULT_NOTIFICATION_CATEGORIES,
    incoming: DEFAULT_INCOMING,
    outgoing: DEFAULT_OUTGOING,
  };
  hydrated = false;
  hydration = null;
}
