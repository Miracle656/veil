/**
 * Local notification service for Veil mobile.
 *
 * Fires local notifications when the activity feed detects a new incoming
 * transfer (or, optionally, a completed outgoing transaction). Notifications
 * respect the wallet's lock state and hidden-amounts toggle: when either is
 * active, the notification body never reveals the amount.
 *
 * The Veil drape mark is configured as the notification icon in app.config.ts
 * (expo-notifications plugin). Push (remote) notifications are explicitly out
 * of scope — local-only keeps the wallet self-contained.
 *
 * Requires a new dev build — notification permissions and the icon cannot be
 * added over the air.
 */

import * as Notifications from 'expo-notifications';

import { getHiddenAmounts } from './hiddenAmounts';
import { getNotifIncoming, getNotifOutgoing, hydrateNotifPrefs } from './notificationPrefs';

// ── Lock-state tracking ──────────────────────────────────────────────────────

/**
 * Module-level lock flag. Updated by the root layout whenever the route
 * changes to/from the lock screen. When `true`, every notification suppresses
 * the amount so a shoulder-surfing bystander learns *something* arrived but
 * not *how much*.
 */
let _isAppLocked = false;

/** Called by the root layout when the route transitions to the lock screen. */
export function setAppLocked(locked: boolean): void {
  _isAppLocked = locked;
}

/** Whether the wallet is currently on the lock screen. */
export function isAppLocked(): boolean {
  return _isAppLocked;
}

// ── Permission handling ──────────────────────────────────────────────────────

/**
 * Request notification permissions. Idempotent — returns the existing grant
 * if already authorised. The permission prompt is shown only once per install;
 * subsequent calls resolve immediately.
 *
 * Returns `true` when notifications are authorised (foreground or alert level).
 */
export async function requestNotificationPermissions(): Promise<boolean> {
  const existing = (await Notifications.getPermissionsAsync()) as { granted?: boolean };
  if (existing.granted) return true;

  const result = (await Notifications.requestPermissionsAsync()) as { granted?: boolean };
  return !!result.granted;
}

// ── Foreground presentation ──────────────────────────────────────────────────

/**
 * Configure how notifications appear when the app is in the foreground.
 * The default Expo handler replaces the current screen with the notification
 * content, which is wrong for an activity-feed notification — we just want a
 * banner.
 */
export function configureNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

// ── Amount masking helper ────────────────────────────────────────────────────

/**
 * Build the notification body text, hiding the amount when the wallet is
 * locked or the user has hidden amounts turned on.
 */
function buildBody(
  type: 'received' | 'sent' | 'confirmed',
  amount: string,
  asset: string,
): string {
  const hideAmount = _isAppLocked || getHiddenAmounts();

  if (hideAmount) {
    switch (type) {
      case 'received':
        return 'You received a payment.';
      case 'sent':
        return 'Your payment was sent.';
      case 'confirmed':
        return 'A transaction confirmed.';
    }
  }

  switch (type) {
    case 'received':
      return `Received ${amount} ${asset}`;
    case 'sent':
      return `Sent ${amount} ${asset}`;
    case 'confirmed':
      return `${amount} ${asset} confirmed`;
  }
}

// ── Notification scheduling ──────────────────────────────────────────────────

/**
 * Fire a local notification for a new transfer. Respects the lock state,
 * hidden-amounts toggle, and per-type notification preferences.
 *
 * No-op when the relevant preference is disabled.
 */
export async function fireTransferNotification(params: {
  type: 'received' | 'sent' | 'confirmed';
  amount: string;
  asset: string;
  counterparty?: string;
  /** Activity-feed record id, so a tap can open the right place. */
  txId?: string;
  /** Stellar transaction hash, for a future per-transaction screen. */
  hash?: string;
}): Promise<void> {
  await hydrateNotifPrefs();

  const pref = params.type === 'received' ? getNotifIncoming() : getNotifOutgoing();
  if (!pref) return;

  const title =
    params.type === 'received'
      ? 'Payment received'
      : params.type === 'sent'
        ? 'Payment sent'
        : 'Transaction confirmed';

  const body = buildBody(params.type, params.amount, params.asset);

  const counterparty = params.counterparty;
  const subtitle =
    counterparty && !_isAppLocked
      ? `From ${counterparty.length > 12 ? `${counterparty.slice(0, 6)}…${counterparty.slice(-6)}` : counterparty}`
      : undefined;

  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      subtitle,
      // The Veil drape mark is configured as the Android small icon in
      // app.config.ts; iOS uses the app icon automatically.
      sound: false,
      // Carried so tapping the notification can open the transaction rather
      // than dumping the user on whatever screen they last had open. Without
      // this the tap is indistinguishable from opening the app normally.
      data: {
        route: NOTIFICATION_ROUTE,
        txId: params.txId,
        hash: params.hash,
        type: params.type,
      },
    },
    trigger: null, // fire immediately
  });
}

/** Where a tapped transfer notification should land. */
export const NOTIFICATION_ROUTE = '/transactions';

/**
 * The route a notification response should open, or null when it carries none.
 *
 * Kept pure and exported so the routing rule is testable without Expo's
 * notification runtime: the tap path is impossible to exercise in a unit test
 * otherwise, and it is the half most likely to silently do nothing.
 */
export function routeForNotificationResponse(response: unknown): string | null {
  const data = (response as { notification?: { request?: { content?: { data?: unknown } } } })
    ?.notification?.request?.content?.data;
  if (!data || typeof data !== 'object') return null;
  const route = (data as { route?: unknown }).route;
  return typeof route === 'string' && route.startsWith('/') ? route : null;
}
