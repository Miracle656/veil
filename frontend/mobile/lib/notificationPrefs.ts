/**
 * Notification preferences and optional install-scoped server sync (#1287).
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
 * Preferences always persist locally in `AsyncStorage` so `lib/notifications.ts`
 * and cold restarts read them immediately. Remote sync against wraith
 * (`POST /push/devices` and `DELETE /push/devices/:token`, #1274) is gated
 * behind `isRemotePushEnabled()` from `lib/pushToken.ts` (`EXPO_PUBLIC_REMOTE_PUSH`,
 * off by default) and delegates token ownership and HTTP requests to
 * `lib/pushToken.ts` so a single module owns the push token.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import { getWraithUrl } from './nfts';
import {
  deregisterPushDevice,
  deviceMetadata,
  getPushToken,
  isRemotePushEnabled,
  redactPushToken,
  registerPushDevice,
} from './pushToken';

export { redactPushToken } from './pushToken';

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

/** Last push token confirmed registered with wraith, kept so all-off can delete it. */
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
    example: 'Rare holiday greetings and milestones — off until you turn it on.',
    switchable: true,
  },
];

export type NotificationBoundaryFact = {
  key: string;
  claim: string;
  detail: string;
};

/**
 * Plain statement of what this app sends to Veil for notifications when remote
 * push is off (the default build while #1274 is not live).
 */
export const NOTIFICATION_CAN_SEE: readonly NotificationBoundaryFact[] = [
  {
    key: 'remote-push-off',
    claim: 'Nothing sent for notifications in this build',
    detail:
      'Remote push is off by default in this build. Your category switches stay on this phone, and this app does not request an Expo push token or contact a push registry.',
  },
  {
    key: 'when-remote-push-enabled',
    claim: 'If a build turns remote push on',
    detail:
      'This app sends only a random install ID generated on this phone, its Expo push token, OS platform, app version, locale, and your four category switches.',
  },
];

const NOTIFICATION_CAN_SEE_REMOTE_ENABLED: readonly NotificationBoundaryFact[] = [
  {
    key: 'install-record',
    claim: 'A random install ID and Expo push token',
    detail:
      'When syncing notifications, this app sends a random ID generated on this phone, its Expo push token, OS platform, app version, and locale.',
  },
  {
    key: 'category-switches',
    claim: 'Your four category switches',
    detail:
      'This app sends your Activity, Security, Product, and Seasonal choices against that install ID, and sends a delete request for the token when all switchable categories are turned off.',
  },
];

/**
 * Plain statement of what this client never includes in notification requests
 * and how local alerts behave on this phone. Scoped strictly to client
 * behaviour — never promises unverified remote server behaviour.
 */
export const NOTIFICATION_CANNOT_SEE: readonly NotificationBoundaryFact[] = [
  {
    key: 'wallet-identity',
    claim: 'Your wallet address, keys, or passkey',
    detail:
      'This app never includes your wallet address, public key, passkey credential ID, recovery setup, or NIN in notification preference or push registration requests.',
  },
  {
    key: 'balances-and-amounts',
    claim: 'Your balances, transactions, or contacts',
    detail:
      'This app never sends balances, transaction history, or contacts with notification preferences. Local transfer banners are composed on this phone and hide amounts whenever the wallet is locked or hidden-amounts is turned on.',
  },
];

/** Return accurate client-side privacy copy for the active remote-push flag state. */
export function getNotificationPrivacyFacts(
  remotePushEnabled: boolean = isRemotePushEnabledForPrefs(),
): {
  canSee: readonly NotificationBoundaryFact[];
  cannotSee: readonly NotificationBoundaryFact[];
} {
  return {
    canSee: remotePushEnabled ? NOTIFICATION_CAN_SEE_REMOTE_ENABLED : NOTIFICATION_CAN_SEE,
    cannotSee: NOTIFICATION_CANNOT_SEE,
  };
}

// ── State ────────────────────────────────────────────────────────────────────

let prefs: NotifPrefs = {
  ...DEFAULT_NOTIFICATION_CATEGORIES,
  incoming: DEFAULT_INCOMING,
  outgoing: DEFAULT_OUTGOING,
};
let hydrated = false;
let lastSync: NotificationServerSyncResult | null = null;
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
 * when remote push is enabled (#1287).
 */
export function areAllSwitchableCategoriesOff(
  categories: Pick<NotificationCategoryPrefs, 'activity' | 'product' | 'seasonal'> = prefs,
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

/** Last server-sync outcome recorded in this session, or `null` if no sync has run yet. */
export function getLastNotificationSync(): NotificationServerSyncResult | null {
  return lastSync;
}

/** Short human summary of enabled categories for the Settings overview row. */
export function summarizeNotificationCategories(
  categories: NotificationCategoryPrefs = getNotificationCategories(),
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

/** Subscribe to preference and sync-status changes. Returns an unsubscribe function. */
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

export type NotificationServerSyncResult =
  | { status: 'disabled' }
  | { status: 'synced'; token: string }
  | { status: 'deregistered'; token: string }
  | { status: 'unsupported' }
  | { status: 'no-registry' }
  | { status: 'no-token' }
  | { status: 'failed'; reason: string };

export interface NotificationSyncDeps {
  platform?: string;
  remotePushEnabled?: () => boolean;
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

/** Whether remote push sync is active under current build flag / test configuration. */
export function isRemotePushEnabledForPrefs(): boolean {
  return configuredSyncDeps.remotePushEnabled
    ? configuredSyncDeps.remotePushEnabled()
    : isRemotePushEnabled();
}

function recordSyncResult(result: NotificationServerSyncResult): NotificationServerSyncResult {
  lastSync = result;
  notify();
  return result;
}

/**
 * Reflect `categories` onto the install record in wraith (#1274 / #1287) via
 * `lib/pushToken.ts`.
 *
 * - Respects `isRemotePushEnabled()` (`EXPO_PUBLIC_REMOTE_PUSH`, off by default):
 *   when off, returns `{ status: 'disabled' }` without fetching a token or
 *   contacting wraith.
 * - When enabled and every switchable category is off, calls
 *   `deregisterPushDevice` (`DELETE /push/devices/:token`). Only a 2xx server
 *   response counts as `{ status: 'deregistered' }`; HTTP 404 and all other
 *   non-2xx responses return `{ status: 'failed' }`.
 * - Otherwise upserts via `registerPushDevice` (`POST /push/devices`).
 */
export async function syncNotificationPrefsToServer(
  categories: NotificationCategoryPrefs = getNotificationCategories(),
  overrides: NotificationSyncDeps = {},
): Promise<NotificationServerSyncResult> {
  const merged = { ...configuredSyncDeps, ...overrides };
  const remoteEnabled = (merged.remotePushEnabled ?? (() => isRemotePushEnabled()))();
  if (!remoteEnabled) {
    return recordSyncResult({ status: 'disabled' });
  }

  const platform = merged.platform ?? Platform.OS;
  if (platform !== 'ios' && platform !== 'android') {
    return recordSyncResult({ status: 'unsupported' });
  }

  const base = merged.wraithUrl === undefined ? getWraithUrl() : merged.wraithUrl;
  if (!base) {
    return recordSyncResult({ status: 'no-registry' });
  }

  const report = merged.report ?? ((msg: string) => console.warn(`[push-prefs] ${msg}`));
  const doFetch = merged.fetchImpl ?? fetch;

  let token: string | null = null;
  try {
    token = merged.getToken
      ? await merged.getToken()
      : await getPushToken({ platform, remotePushEnabled: () => true });
  } catch (err) {
    const reason = `resolving push token failed: ${err instanceof Error ? err.message : String(err)}`;
    report(reason);
    return recordSyncResult({ status: 'failed', reason });
  }

  if (!token && areAllSwitchableCategoriesOff(categories)) {
    const cached = await AsyncStorage.getItem(NOTIF_REGISTERED_TOKEN_KEY).catch(() => null);
    token = cached && cached.trim() ? cached.trim() : null;
  }

  if (!token) {
    return recordSyncResult({ status: 'no-token' });
  }

  if (areAllSwitchableCategoriesOff(categories)) {
    try {
      const deregistered = await deregisterPushDevice(token, {
        wraithUrl: base,
        fetchImpl: doFetch,
      });
      if (!deregistered) {
        return recordSyncResult({ status: 'no-registry' });
      }
      await AsyncStorage.removeItem(NOTIF_REGISTERED_TOKEN_KEY).catch(() => undefined);
      return recordSyncResult({ status: 'deregistered', token });
    } catch (err) {
      const reason = `deregistering ${redactPushToken(token)} failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      report(reason);
      return recordSyncResult({ status: 'failed', reason });
    }
  }

  try {
    const installId = await (merged.getInstallId ?? getOrCreateInstallId)();
    const { appVersion, locale } = (merged.metadata ?? deviceMetadata)();
    const synced = await registerPushDevice(
      {
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
      },
      { wraithUrl: base, fetchImpl: doFetch },
    );
    if (!synced) {
      return recordSyncResult({ status: 'no-registry' });
    }
    await AsyncStorage.setItem(NOTIF_REGISTERED_TOKEN_KEY, token).catch(() => undefined);
    return recordSyncResult({ status: 'synced', token });
  } catch (err) {
    const reason = `syncing ${redactPushToken(token)} failed: ${
      err instanceof Error ? err.message : String(err)
    }`;
    report(reason);
    return recordSyncResult({ status: 'failed', reason });
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
 * Set a notification category preference, persist it on the device, and
 * attempt server sync when `EXPO_PUBLIC_REMOTE_PUSH` is enabled.
 *
 * `security` cannot be switched off: passing `('security', false)` leaves
 * `security` enabled and returns the unchanged category snapshot.
 */
export async function setNotificationCategory(
  category: NotificationCategory,
  enabled: boolean,
  syncOverrides?: NotificationSyncDeps,
): Promise<{ categories: NotificationCategoryPrefs; sync: NotificationServerSyncResult }> {
  await hydrateNotifPrefs();

  if (category === 'security') {
    await AsyncStorage.setItem(NOTIF_CATEGORY_SECURITY_KEY, '1');
    const categories = getNotificationCategories();
    return { categories, sync: { status: 'disabled' } };
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
 * Reset in-memory hydration cache and last-sync state so tests can simulate a
 * cold app restart against whatever keys currently sit in `AsyncStorage`.
 */
export function resetNotifPrefsMemoryForTests(): void {
  prefs = {
    ...DEFAULT_NOTIFICATION_CATEGORIES,
    incoming: DEFAULT_INCOMING,
    outgoing: DEFAULT_OUTGOING,
  };
  hydrated = false;
  hydration = null;
  lastSync = null;
}
