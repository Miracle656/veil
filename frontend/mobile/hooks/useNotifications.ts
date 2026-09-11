/**
 * Activity-to-notification bridge.
 *
 * Subscribes to the module-level activity feed store and fires a local
 * notification whenever a *new* incoming transfer (or, optionally, a
 * completed outgoing transaction) appears. "New" is defined as an id that
 * was not present in the previous snapshot — so the initial hydration never
 * triggers a notification, only fresh poll results do.
 *
 * Mount once at the app root alongside the other gate components.
 */

import { useEffect, useRef } from 'react';

import { movementKey, subscribeActivityFeed, type TxRecord } from '../lib/activityFeed';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { useRouter, useSegments } from 'expo-router';

import { fireTransferNotification, routeForNotificationResponse } from '../lib/notifications';
import { consumePendingRoute, setPendingRoute } from '../lib/pendingRoute';

/**
 * Movements already accounted for. On each new snapshot, anything not in this
 * set is treated as freshly arrived and may trigger a notification.
 *
 * Keyed by movement rather than by row id, because one payment can arrive
 * under two different ids — the contract's transfer event first, the
 * fee-payer's classic Horizon operation once it is indexed. Keyed by id, the
 * second arrival looks like a new payment and notifies about a transfer the
 * user was already told about.
 */
const seenIds = new Set<string>();

/**
 * Whether the very first snapshot has been received. The initial hydration
 * (fetching existing history) must not fire notifications — only subsequent
 * poll updates should.
 */
let initialised = false;

/**
 * The seen set, on disk.
 *
 * Holding it only in memory was not enough. `subscribeActivityFeed` replays the
 * current records to a new subscriber immediately, and on a fresh JS context
 * that is an empty array — so the "first snapshot" that seeds the set seeded
 * nothing, marked itself done, and every historical transfer then arrived
 * looking brand new. One notification per past payment, on every Metro reload
 * and on every cold start after a force-quit.
 *
 * Persisting it fixes both, and keeps the one case that must still work: a
 * transfer that genuinely arrives while the app is closed is not in the stored
 * set, so it still notifies.
 */
const SEEN_KEY = 'veil_notified_movements';
/** Enough to cover any plausible backlog; the feed itself only holds 50. */
const SEEN_LIMIT = 300;

async function loadSeen(): Promise<Set<string> | null> {
  try {
    const raw = await AsyncStorage.getItem(SEEN_KEY);
    if (raw === null) return null; // never stored: a fresh install
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((k) => typeof k === 'string')) : null;
  } catch {
    return null;
  }
}

async function saveSeen(seen: Set<string>): Promise<void> {
  try {
    await AsyncStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-SEEN_LIMIT)));
  } catch {
    /* storage full or unavailable: worst case a notification repeats */
  }
}

export function useNotifications(): void {
  const router = useRouter();
  const segments = useSegments();
  const seenRef = useRef(seenIds);
  const initRef = useRef(initialised);

  // Tapping a notification should open the transaction list. Two paths, and
  // missing either one makes the tap appear to do nothing:
  //
  //   - the app is already running, so a response listener fires;
  //   - the app was killed and the tap launched it, in which case no listener
  //     exists yet and the response is only available from
  //     getLastNotificationResponseAsync().
  //
  // Neither one navigates directly. The tap is usually what foregrounds the
  // app, and the auto-lock treats a return from background as a reason to
  // `replace` to /lock — so a push from here is either overwritten by that
  // replace, or survives only until the unlock sends the user to /dashboard.
  // Both listeners therefore record the destination and let the effect below
  // travel to it once the app is somewhere it can.
  useEffect(() => {
    let cancelled = false;

    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (cancelled || !response) return;
      const route = routeForNotificationResponse(response);
      if (route) setPendingRoute(route);
    });

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const route = routeForNotificationResponse(response);
      if (route) setPendingRoute(route);
    });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  // Travel to a recorded destination as soon as the app is not on the lock
  // screen. Keyed on `segments`, so this runs when the router first mounts
  // (covering a cold start, where a push during mount silently does nothing)
  // and again the moment the user unlocks.
  useEffect(() => {
    if (segments[0] === 'lock') return;
    const route = consumePendingRoute();
    if (route) router.push(route as never);
  }, [router, segments]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    // Nothing may be judged new until the stored set is back. Subscribing first
    // would hand us the whole history with an empty set to compare it against,
    // which is the flood this exists to prevent.
    void loadSeen().then((stored) => {
      if (cancelled) return;
      if (stored) {
        for (const k of stored) seenRef.current.add(k);
        // A stored set means we already know what the user has been told about,
        // so the next snapshot is judged, not swallowed.
        initRef.current = true;
        initialised = true;
      }
      unsubscribe = subscribeActivityFeed(onSnapshot);
    });

    function onSnapshot(records: TxRecord[]) {
      if (!initRef.current) {
        // Fresh install. Seed from the first snapshot that actually carries
        // something: an empty one says nothing about what the user has seen,
        // and treating it as the seed is what let the history through.
        if (records.length === 0) return;
        for (const r of records) seenRef.current.add(movementKey(r));
        initRef.current = true;
        // Write through to the module-level flag as well. `useRef` copied the
        // value at first render, so without this the hook re-seeds on every
        // remount — and a transfer landing during one would be swallowed.
        initialised = true;
        void saveSeen(seenRef.current);
        return;
      }

      // Look for records we haven't seen before.
      for (const tx of records) {
        const key = movementKey(tx);
        if (seenRef.current.has(key)) continue;
        seenRef.current.add(key);

        // Fire a notification for the new record.
        if (tx.type === 'received') {
          void fireTransferNotification({
            type: 'received',
            amount: tx.amount,
            asset: tx.asset,
            counterparty: tx.counterparty,
            txId: tx.id,
            hash: tx.hash,
          });
        } else if (tx.type === 'sent') {
          void fireTransferNotification({
            type: 'sent',
            amount: tx.amount,
            asset: tx.asset,
            counterparty: tx.counterparty,
            txId: tx.id,
            hash: tx.hash,
          });
        }
        // 'swapped' records are intentionally not notified — they are
        // internal wallet operations, not external transfers.
      }

      // Persist after each judged snapshot, so a reload or a force-quit picks
      // up where this left off rather than starting from nothing.
      void saveSeen(seenRef.current);
    }

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);
}
