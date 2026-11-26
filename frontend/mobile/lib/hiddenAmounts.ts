/**
 * "Hide amounts" — a privacy toggle that masks every balance and amount on
 * screen behind dots, so the user can open the app in public without showing
 * their money. On-brand for Veil, and the cheapest privacy win we ship.
 *
 * The preference is module state + AsyncStorage, using the same external-store
 * shape as `theme.ts` / `currency.ts`, so `useHiddenAmounts()` works anywhere
 * with no provider. It is a display preference, not a secret, so plain
 * AsyncStorage (not the keychain) is the right home.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

/** AsyncStorage key holding the hide-amounts preference (`'1'` / `'0'`). */
export const HIDDEN_AMOUNTS_STORAGE_KEY = 'veil_hide_amounts';

/** The mask shown in place of a hidden amount. */
export const AMOUNT_MASK = '••••';

/**
 * Return `masked` when amounts are hidden, otherwise the real value. A tiny
 * helper, but centralising it means no screen forgets the toggle: components
 * call `maskAmount(hidden, formatted)` instead of branching by hand.
 */
export function maskAmount(hidden: boolean, value: string, mask: string = AMOUNT_MASK): string {
  return hidden ? mask : value;
}

// ── State (external store, mirrors theme.ts) ─────────────────────────────────

let hiddenState = false;
let hydrated = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to hide-amounts changes. Returns an unsubscribe function. */
export function subscribeToHiddenAmounts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether amounts are currently hidden. Cheap enough to call in a render. */
export function getHiddenAmounts(): boolean {
  return hiddenState;
}

/** Whether the stored preference has been read yet. */
export function isHiddenAmountsHydrated(): boolean {
  return hydrated;
}

let hydration: Promise<boolean> | null = null;

/** Load the stored preference. Idempotent: repeated calls share one read. */
export function hydrateHiddenAmounts(): Promise<boolean> {
  hydration ??= AsyncStorage.getItem(HIDDEN_AMOUNTS_STORAGE_KEY)
    .catch(() => null)
    .then((stored) => {
      hydrated = true;
      const next = stored === '1';
      if (next !== hiddenState) hiddenState = next;
      notify();
      return hiddenState;
    });
  return hydration;
}

// Start reading at import so the preference is usually in place by first paint.
void hydrateHiddenAmounts();

/** Set the hide-amounts preference and persist it. */
export async function setHiddenAmounts(hidden: boolean): Promise<void> {
  if (hidden !== hiddenState) {
    hiddenState = hidden;
    notify();
  }
  hydration = Promise.resolve(hidden);
  hydrated = true;
  await AsyncStorage.setItem(HIDDEN_AMOUNTS_STORAGE_KEY, hidden ? '1' : '0');
}

/** Flip the hide-amounts preference, persisting the result. */
export async function toggleHiddenAmounts(): Promise<boolean> {
  const next = !hiddenState;
  await setHiddenAmounts(next);
  return next;
}
