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

import { subscribeActivityFeed, type TxRecord } from '../lib/activityFeed';
import { fireTransferNotification } from '../lib/notifications';

/**
 * Set of record ids from the previous activity-feed snapshot. On each new
 * snapshot, any id not in this set is treated as a freshly-arrived record
 * and may trigger a notification.
 */
const seenIds = new Set<string>();

/**
 * Whether the very first snapshot has been received. The initial hydration
 * (fetching existing history) must not fire notifications — only subsequent
 * poll updates should.
 */
let initialised = false;

export function useNotifications(): void {
  const seenRef = useRef(seenIds);
  const initRef = useRef(initialised);

  useEffect(() => {
    const unsubscribe = subscribeActivityFeed((records) => {
      if (!initRef.current) {
        // First snapshot: seed the seen set without firing notifications.
        for (const r of records) seenRef.current.add(r.id);
        initRef.current = true;
        return;
      }

      // Look for records we haven't seen before.
      for (const tx of records) {
        if (seenRef.current.has(tx.id)) continue;
        seenRef.current.add(tx.id);

        // Fire a notification for the new record.
        if (tx.type === 'received') {
          void fireTransferNotification({
            type: 'received',
            amount: tx.amount,
            asset: tx.asset,
            counterparty: tx.counterparty,
          });
        } else if (tx.type === 'sent') {
          void fireTransferNotification({
            type: 'sent',
            amount: tx.amount,
            asset: tx.asset,
            counterparty: tx.counterparty,
          });
        }
        // 'swapped' records are intentionally not notified — they are
        // internal wallet operations, not external transfers.
      }
    });

    return unsubscribe;
  }, []);
}
