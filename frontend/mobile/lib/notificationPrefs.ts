/**
 * Notification preferences — controls which local notifications fire and which
 * are silenced. Two toggles:
 *
 *   - **incoming transfers**: on by default (the core notification-worthy event
 *     for a wallet).
 *   - **outgoing confirmations**: off by default (chattier; a user who just
 *     signed the tx already knows it happened).
 *
 * Stored in AsyncStorage. Same external-store shape as theme.ts / hiddenAmounts.ts
 * so any component can subscribe with a plain hook, no provider needed.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Keys ─────────────────────────────────────────────────────────────────────

/** AsyncStorage key for the incoming-transfers toggle. */
export const NOTIF_INCOMING_KEY = 'veil_notif_incoming';

/** AsyncStorage key for the outgoing-confirmations toggle. */
export const NOTIF_OUTGOING_KEY = 'veil_notif_outgoing';

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_INCOMING = true;
const DEFAULT_OUTGOING = false;

// ── State ────────────────────────────────────────────────────────────────────

interface NotifPrefs {
  incoming: boolean;
  outgoing: boolean;
}

let prefs: NotifPrefs = {
  incoming: DEFAULT_INCOMING,
  outgoing: DEFAULT_OUTGOING,
};
let hydrated = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

// ── Public getters ───────────────────────────────────────────────────────────

/** Whether incoming-transfer notifications are enabled. */
export function getNotifIncoming(): boolean {
  return prefs.incoming;
}

/** Whether outgoing-confirmation notifications are enabled. */
export function getNotifOutgoing(): boolean {
  return prefs.outgoing;
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

/** Load stored preferences. Idempotent: repeated calls share one read. */
export function hydrateNotifPrefs(): Promise<NotifPrefs> {
  hydration ??= Promise.all([
    AsyncStorage.getItem(NOTIF_INCOMING_KEY).catch(() => null),
    AsyncStorage.getItem(NOTIF_OUTGOING_KEY).catch(() => null),
  ]).then(([storedIncoming, storedOutgoing]) => {
    prefs = {
      incoming: storedIncoming === null ? DEFAULT_INCOMING : storedIncoming === '1',
      outgoing: storedOutgoing === null ? DEFAULT_OUTGOING : storedOutgoing === '1',
    };
    hydrated = true;
    notify();
    return prefs;
  });
  return hydration;
}

// Start reading at import so preferences are in place before the first poll.
void hydrateNotifPrefs();

// ── Mutations ────────────────────────────────────────────────────────────────

function update(next: NotifPrefs): void {
  prefs = next;
  hydrated = true;
  hydration = Promise.resolve(next);
  notify();
}

/** Toggle incoming-transfer notifications. */
export async function setNotifIncoming(enabled: boolean): Promise<void> {
  update({ ...prefs, incoming: enabled });
  await AsyncStorage.setItem(NOTIF_INCOMING_KEY, enabled ? '1' : '0');
}

/** Toggle outgoing-confirmation notifications. */
export async function setNotifOutgoing(enabled: boolean): Promise<void> {
  update({ ...prefs, outgoing: enabled });
  await AsyncStorage.setItem(NOTIF_OUTGOING_KEY, enabled ? '1' : '0');
}
