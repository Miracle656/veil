/**
 * Single source of truth for "dust" payments: amounts so small they round to
 * "0" at the 4-decimal display precision used across the mobile app.
 */

/**
 * Half of the smallest displayed unit (0.0001). Anything strictly below this
 * rounds to "0" under `toLocaleString('en-US', { maximumFractionDigits: 4 })`.
 */
export const DUST_THRESHOLD = 0.00005;

/** Quiet display label for a dust amount (without asset code). */
export const DUST_AMOUNT_LABEL = '< 0.0001';

/**
 * Returns true when a raw or formatted numeric amount is too small to display
 * at 4-decimal precision (i.e. it would render as "0").
 */
export function isDustAmount(raw: string | number | undefined | null): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'string' && raw.trim() === '') return false;
  const n = typeof raw === 'number' ? raw : Number(raw.replace(/,/g, '').trim());
  if (!Number.isFinite(n)) return false;
  return Math.abs(n) < DUST_THRESHOLD;
}

/**
 * Decide whether an activity row is dust.
 *
 * Prefers the explicit `isDust` flag captured from the raw amount when the row
 * was built, and falls back to inspecting the formatted `amount` string.
 */
export function isDustRecord(tx: { amount: string; isDust?: boolean }): boolean {
  if (typeof tx.isDust === 'boolean') return tx.isDust;
  return isDustAmount(tx.amount);
}

/**
 * Format an activity row's amount for display in history views.
 * Dust rows show "< 0.0001 <ASSET>" instead of "0 <ASSET>".
 */
export function formatDisplayAmount(tx: {
  type?: 'sent' | 'received' | 'swapped';
  amount: string;
  asset: string;
  isDust?: boolean;
}): string {
  if (tx.type !== 'swapped' && isDustRecord(tx)) {
    return `${DUST_AMOUNT_LABEL} ${tx.asset}`;
  }
  return `${tx.amount} ${tx.asset}`;
}
