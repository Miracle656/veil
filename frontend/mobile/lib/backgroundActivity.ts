/**
 * Check for payments while the app is closed, and notify about them.
 *
 * Notifications used to come only from the in-app activity poll, which stops
 * when the app is backgrounded — so a payment was announced the next time the
 * user happened to open Veil, which is exactly when they no longer needed
 * telling.
 *
 * This is a periodic OS-scheduled check, not push. Android runs it through
 * WorkManager at most every 15 minutes, later on a phone saving battery, and
 * some manufacturers' battery managers skip it for apps that are swiped away.
 * Instant delivery needs a server watching the chain and sending real push
 * notifications; this closes most of the gap without one.
 *
 * The task is defined at import, from index.js, because Android can start the
 * JS runtime just to run it, before any screen mounts.
 */

import { AppState, Platform } from 'react-native';

import { movementKey } from './activityFeed';
import { loadHorizonActivity } from './horizonActivity';
import { hydrateNetwork } from './network';
import { fireTransferNotification } from './notifications';
import { loadNotifiedMovements, notifiedMovements, saveNotifiedMovements } from './notifiedMovements';
import { getWalletAddress } from './walletStore';

export const ACTIVITY_TASK = 'veil-activity-check';

/** Minutes. Android will not run a periodic worker more often than this. */
const INTERVAL_MINUTES = 15;

type BackgroundTaskModule = typeof import('expo-background-task');
type TaskManagerModule = typeof import('expo-task-manager');

/**
 * Loaded defensively. Both are native modules, and importing one into a binary
 * built without it throws at import time — from index.js, that is a crash on
 * launch for anyone still on an older dev client. Without them the app notifies
 * only while open, as before.
 */
function loadNativeModules(): { BackgroundTask: BackgroundTaskModule; TaskManager: TaskManagerModule } | null {
  if (Platform.OS === 'web') return null;
  try {
    return {
      BackgroundTask: require('expo-background-task') as BackgroundTaskModule,
      TaskManager: require('expo-task-manager') as TaskManagerModule,
    };
  } catch {
    return null;
  }
}

const native = loadNativeModules();

/**
 * One background pass. Returns how many notifications it posted.
 *
 * Exported for tests; the OS calls it through the task below.
 */
export async function checkForNewActivity(): Promise<number> {
  // In the foreground the in-app poll is already watching, and it notifies
  // from the same shared set; doing it here too is just extra requests.
  if (AppState.currentState === 'active') return 0;

  await hydrateNetwork();
  const address = await getWalletAddress();
  if (!address) return 0;

  // No baseline means the app has never shown this wallet's history: every
  // record would look new. The first in-app load seeds it instead.
  if (!(await loadNotifiedMovements())) return 0;

  const records = await loadHorizonActivity(address);
  const seen = notifiedMovements();
  let posted = 0;

  // Oldest first, so the newest payment ends up on top of the shade.
  for (const tx of [...records].reverse()) {
    const key = movementKey(tx);
    if (seen.has(key)) continue;
    seen.add(key);
    if (tx.type !== 'received' && tx.type !== 'sent') continue;

    await fireTransferNotification({
      type: tx.type,
      amount: tx.amount,
      asset: tx.asset,
      counterparty: tx.counterparty,
      txId: tx.id,
      hash: tx.hash,
      // The wallet is effectively locked while it is closed, and the in-app
      // rule for a locked wallet is that a notification never shows the amount.
      hideAmount: true,
    });
    posted++;
  }

  await saveNotifiedMovements();
  return posted;
}

if (native) {
  const { BackgroundTask, TaskManager } = native;
  try {
    TaskManager.defineTask(ACTIVITY_TASK, async () => {
      try {
        await checkForNewActivity();
        return BackgroundTask.BackgroundTaskResult.Success;
      } catch (err) {
        console.warn('[activity] background check failed:', err instanceof Error ? err.message : err);
        return BackgroundTask.BackgroundTaskResult.Failed;
      }
    });
  } catch (err) {
    console.warn('[activity] background task unavailable:', err instanceof Error ? err.message : err);
  }
}

/** Ask the OS to run the check periodically. Safe to call on every launch. */
export async function registerActivityCheck(): Promise<void> {
  if (!native) return;
  const { BackgroundTask } = native;
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) return;
    await BackgroundTask.registerTaskAsync(ACTIVITY_TASK, { minimumInterval: INTERVAL_MINUTES });
  } catch (err) {
    console.warn('[activity] background check not registered:', err instanceof Error ? err.message : err);
  }
}
