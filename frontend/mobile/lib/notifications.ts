/**
 * Local notification service for Veil mobile.
 *
 * Fires local notifications when the activity feed detects a new incoming
 * transfer (or, optionally, a completed outgoing transaction). Notification
 * content is generic; transaction details stay on-device in the activity feed.
 *
 * The Veil drape mark is configured as the notification icon in app.config.ts
 * (expo-notifications plugin). There is no remote-push sender in this app;
 * local notifications use the same generic-content boundary.
 *
 * Requires a new dev build — notification permissions and the icon cannot be
 * added over the air.
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { getNotifIncoming, getNotifOutgoing, hydrateNotifPrefs } from './notificationPrefs';

// ── Permission handling ──────────────────────────────────────────────────────

/**
 * Request notification permissions. Idempotent — returns the existing grant
 * if already authorised. The permission prompt is shown only once per install;
 * subsequent calls resolve immediately.
 *
 * Returns `true` when notifications are authorised (foreground or alert level).
 */
export async function requestNotificationPermissions(): Promise<boolean> {
  // `expo-notifications` throws on web rather than reporting "denied", and a
  // throw here is indistinguishable from a refusal to anyone reading the
  // result. There is no permission to grant on web, so the honest answer is
  // no — see `NOTIFICATIONS_SUPPORTED` in hooks/useNotifications.ts.
  if (Platform.OS === 'web') return false;

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
export async function configureNotificationChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;

  // Android 8+ takes importance from the CHANNEL, not from the notification.
  // Without one declared, expo-notifications lands on a default channel at
  // DEFAULT importance, which files the notification quietly into the shade —
  // it never becomes the heads-up banner that slides down over whatever the
  // user is looking at. For "you were just paid", the banner is the point.
  //
  // Creating a channel that already exists is a no-op, so this is safe on every
  // launch. Note the importance of an EXISTING channel cannot be raised from
  // code — Android reserves that for the user — so a device that already
  // installed a build without this keeps the quiet channel until the app is
  // reinstalled or the user changes it in system settings.
  await Notifications.setNotificationChannelAsync('transfers', {
    name: 'Transfers',
    description: 'Payments arriving in and leaving your wallet',
    importance: Notifications.AndroidImportance.HIGH,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    sound: null,
    vibrationPattern: [0, 200],
    enableVibrate: true,
  });
}

export function configureNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      // shouldShowAlert was the old name for the two flags below. Expo warns on
      // it now and it carried no extra meaning, so it is simply gone.
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

// ── Private-payload boundary ─────────────────────────────────────────────────

/**
 * Notification bodies are deliberately limited to generic copy. A strict
 * allowlist also rejects names and any future dynamic text that does not match
 * one of these messages.
 */
const SAFE_NOTIFICATION_BODIES = new Set([
  'A payment arrived.',
  'A payment was sent.',
  'A transaction was confirmed.',
]);

export function assertSafePushBody(body: string): string {
  const containsPrivateShape =
    /\b[GC][A-Z2-7]{55}\b/.test(body) ||
    /\b[0-9a-f]{64}\b/i.test(body) ||
    /(?<!\d)\d{11}(?!\d)/.test(body) ||
    /\b\d+(?:,\d{3})*(?:\.\d+)\b/.test(body);

  if (containsPrivateShape || !SAFE_NOTIFICATION_BODIES.has(body)) {
    throw new Error(
      'Refusing to send a notification body containing private or unapproved content.'
    );
  }

  return body;
}

function buildBody(type: 'received' | 'sent' | 'confirmed'): string {
  switch (type) {
    case 'received':
      return 'A payment arrived.';
    case 'sent':
      return 'A payment was sent.';
    case 'confirmed':
      return 'A transaction was confirmed.';
  }
}

/** Middle-truncate an address so both ends stay checkable. */
export function shortenAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-6)}` : address;
}

// ── Notification scheduling ──────────────────────────────────────────────────

/**
 * Fire a generic local notification for a new transfer. Private details are
 * looked up from the on-device activity feed after the user opens the app.
 *
 * No-op when the relevant preference is disabled.
 */
function assertSafeEventId(eventId: string): string {
  const safeShape = /^(?:w-)?[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(eventId);
  const privateShape =
    /^G[A-Z2-7]{55}$/.test(eventId) ||
    /^C[A-Z2-7]{55}$/.test(eventId) ||
    /^[0-9a-f]{64}$/i.test(eventId) ||
    /^\d{11}$/.test(eventId);

  if (!safeShape || privateShape) {
    throw new Error('Refusing to send a notification without a safe activity event id.');
  }

  return eventId;
}

export async function fireTransferNotification(params: {
  type: 'received' | 'sent' | 'confirmed';
  /** Local activity record id, used to look up details after the app opens. */
  eventId: string;
}): Promise<void> {
  assertSafeEventId(params.eventId);

  await hydrateNotifPrefs();

  const pref = params.type === 'received' ? getNotifIncoming() : getNotifOutgoing();
  if (!pref) return;

  const title =
    params.type === 'received'
      ? 'Payment received'
      : params.type === 'sent'
        ? 'Payment sent'
        : 'Transaction confirmed';

  const body = assertSafePushBody(buildBody(params.type));

  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      // The Veil drape mark is configured as the Android small icon in
      // app.config.ts; iOS uses the app icon automatically.
      sound: false,
      data: {
        route: NOTIFICATION_ROUTE,
        eventType: params.type,
        eventId: params.eventId,
      },
    },
    // Android carries the channel on the TRIGGER, not the content, and a null
    // trigger cannot name one — so it would land on the default channel at
    // DEFAULT importance and never appear as a banner. A one-second interval is
    // the shortest trigger that can name a channel; iOS ignores channelId and
    // treats a null trigger as immediate.
    trigger:
      Platform.OS === 'android'
        ? {
            type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
            seconds: 1,
            channelId: 'transfers',
          }
        : null,
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
  const payload = data as { route?: unknown; eventType?: unknown; eventId?: unknown };
  const route = payload.route;
  if (typeof route !== 'string' || !route.startsWith('/')) return null;
  if (route !== NOTIFICATION_ROUTE) return route;

  if (payload.eventId === undefined && payload.eventType === undefined) return route;

  if (
    typeof payload.eventId !== 'string' ||
    !/^(?:w-)?[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(payload.eventId) ||
    /^G[A-Z2-7]{55}$/.test(payload.eventId) ||
    /^C[A-Z2-7]{55}$/.test(payload.eventId) ||
    /^[0-9a-f]{64}$/i.test(payload.eventId) ||
    /^\d{11}$/.test(payload.eventId) ||
    !['received', 'sent', 'confirmed'].includes(String(payload.eventType))
  ) {
    return null;
  }

  return `${route}?eventId=${encodeURIComponent(payload.eventId)}&eventType=${encodeURIComponent(
    String(payload.eventType)
  )}`;
}
