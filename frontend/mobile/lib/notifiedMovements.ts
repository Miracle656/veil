/**
 * The movements the user has already been notified about, shared by the
 * foreground notifier (hooks/useNotifications.ts) and the background check
 * (lib/backgroundActivity.ts).
 *
 * One set in memory, one copy on disk. When the background check runs inside a
 * live app process it must see what the foreground already announced, and the
 * other way round — two sets would tell the user about the same payment twice.
 *
 * Why it is on disk at all: `subscribeActivityFeed` replays the current records
 * to a new subscriber immediately, and on a fresh JS context that is an empty
 * array — so the "first snapshot" that seeded an in-memory set seeded nothing,
 * and every historical transfer then arrived looking brand new. One
 * notification per past payment, on every cold start. Persisting fixes that,
 * and keeps the case that must still work: a transfer that arrives while the
 * app is closed is not in the stored set, so it still notifies.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const SEEN_KEY = 'veil_notified_movements';
/** Enough to cover any plausible backlog; the feed itself only holds 50. */
const SEEN_LIMIT = 300;

const seen = new Set<string>();
let diskRead: Promise<boolean> | null = null;

/** The live set. Mutate it, then call {@link saveNotifiedMovements}. */
export function notifiedMovements(): Set<string> {
  return seen;
}

/**
 * Load the stored set into memory (once per JS context).
 *
 * Resolves `true` when there is a baseline to judge new movements against —
 * either a stored set, or one this context has already seeded. `false` means a
 * fresh install: the first snapshot is history, not news.
 */
export async function loadNotifiedMovements(): Promise<boolean> {
  diskRead ??= (async () => {
    try {
      const raw = await AsyncStorage.getItem(SEEN_KEY);
      if (raw === null) return false;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return false;
      for (const k of parsed) if (typeof k === 'string') seen.add(k);
      return true;
    } catch {
      return false;
    }
  })();
  const stored = await diskRead;
  return stored || seen.size > 0;
}

export async function saveNotifiedMovements(): Promise<void> {
  try {
    await AsyncStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-SEEN_LIMIT)));
  } catch {
    /* storage full or unavailable: worst case a notification repeats */
  }
}

/** Test-only: forget the in-memory state. */
export function __resetNotifiedMovementsForTest(): void {
  seen.clear();
  diskRead = null;
}
