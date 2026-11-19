import AsyncStorage from '@react-native-async-storage/async-storage';

import type { BlendPool, BlendPosition, BlendReserve, EarnAsset } from './blend';

/**
 * Savings — the plain-language view over the Blend positions Earn already
 * manages. Nothing here talks to a pool or signs anything; it only turns
 * positions into "how much is saved, what it earned" and picks which reserve a
 * deposit goes to. Deposits and withdrawals still go through lib/blend.ts.
 *
 * All money arithmetic is in stroops (bigint), never floats.
 */

const STROOPS_DECIMALS = 7;
const STROOPS_PER_UNIT = 10n ** BigInt(STROOPS_DECIMALS);

/** One balance per asset, however many pools hold it. */
export interface SavingsBalance {
  code: EarnAsset;
  /** Current value of everything saved in this asset, in stroops. */
  valueStroops: bigint;
  /** The positions behind it. Needed to take the money out; never shown by default. */
  positions: BlendPosition[];
}

/** Sum positions per asset. Positions in an asset the wallet cannot fund are left out. */
export function savingsBalances(positions: BlendPosition[]): SavingsBalance[] {
  const byCode = new Map<EarnAsset, SavingsBalance>();
  for (const position of positions) {
    if (!position.code) continue;
    const value = BigInt(position.deposited);
    if (value <= 0n) continue;
    const entry = byCode.get(position.code) ?? { code: position.code, valueStroops: 0n, positions: [] };
    entry.valueStroops += value;
    entry.positions.push(position);
    byCode.set(position.code, entry);
  }
  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * Which reserve a deposit in `code` goes to.
 *
 * The user never picks a pool. Today there is one; when there are several the
 * best-paying reserve wins, which is an internal tie-break — the rate is not
 * shown anywhere on the Savings surface.
 */
export function pickReserve(
  pools: BlendPool[],
  code: EarnAsset
): { pool: BlendPool; reserve: BlendReserve } | null {
  let best: { pool: BlendPool; reserve: BlendReserve } | null = null;
  for (const pool of pools) {
    for (const reserve of pool.reserves) {
      if (reserve.code !== code) continue;
      if (!best || reserve.supplyApy > best.reserve.supplyApy) best = { pool, reserve };
    }
  }
  return best;
}

/** The pool names holding money in `code`, for the "where is it held" disclosure. */
export function poolsHolding(balance: SavingsBalance, pools: BlendPool[]): string[] {
  const names = new Set<string>();
  for (const position of balance.positions) {
    const pool = pools.find((p) => p.id === position.poolId);
    names.add(pool ? pool.name : `${position.poolId.slice(0, 6)}…`);
  }
  return [...names];
}

// ── Money formatting ─────────────────────────────────────────────────────────

/**
 * Format stroops as a decimal string with exactly `digits` places, truncating
 * rather than rounding so a displayed balance never exceeds what is there.
 */
export function formatStroops(stroops: bigint, digits: number): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const places = Math.min(Math.max(digits, 0), STROOPS_DECIMALS);
  const scaled = abs / 10n ** BigInt(STROOPS_DECIMALS - places);
  const whole = scaled / 10n ** BigInt(places);
  const frac = (scaled % 10n ** BigInt(places)).toString().padStart(places, '0');
  const wholeText = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${wholeText}${places > 0 ? `.${frac}` : ''}`;
}

/** Parse a user-typed amount into stroops. Null when it is not a positive amount with at most 7 decimals. */
export function parseAmountToStroops(text: string): bigint | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(trimmed)) return null;
  const [whole, frac = ''] = trimmed.split('.');
  const stroops = BigInt(whole) * STROOPS_PER_UNIT + BigInt(frac.padEnd(STROOPS_DECIMALS, '0'));
  return stroops > 0n ? stroops : null;
}

// ── Earned-to-date ───────────────────────────────────────────────────────────

/**
 * The chain does not record how much was put in, only what the position is
 * worth now (see the note on loadBlendPositions), so earnings cannot be read
 * off it. This keeps a small on-device record of the principal instead:
 * `earned = current value - principal`.
 *
 * Principal is set when money is added through Savings, and when Savings first
 * sees a position it has no record of (made through Earn, or before this
 * shipped) it starts from that position's current value. So "earned" means
 * earned since Savings started tracking it, never a guess at the past. The one
 * gap: money added to the same asset through the Earn screen afterwards is not
 * seen, and would read as earnings until the asset is taken out.
 */
export const SAVINGS_PRINCIPAL_KEY = 'veil_savings_principal_v1';

export type PrincipalLedger = Record<string, string>;

export function principalKey(network: string, address: string, code: EarnAsset): string {
  return `${network}:${address}:${code}`;
}

export async function loadLedger(): Promise<PrincipalLedger> {
  try {
    const raw = await AsyncStorage.getItem(SAVINGS_PRINCIPAL_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const ledger: PrincipalLedger = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && /^\d+$/.test(value)) ledger[key] = value;
    }
    return ledger;
  } catch {
    return {};
  }
}

async function saveLedger(ledger: PrincipalLedger): Promise<void> {
  try {
    await AsyncStorage.setItem(SAVINGS_PRINCIPAL_KEY, JSON.stringify(ledger));
  } catch (error) {
    // A display figure; failing to persist it must never break the screen.
    console.warn('[savings] could not save the principal record', error);
  }
}

/**
 * Bring the ledger in line with what is on chain and return each asset's
 * principal in stroops. Pure apart from the write: a position with no record is
 * baselined at its current value, and a record for an asset that is now empty is
 * dropped so the next deposit starts clean.
 */
export function reconcileLedger(
  ledger: PrincipalLedger,
  balances: SavingsBalance[],
  keyFor: (code: EarnAsset) => string,
  allCodes: EarnAsset[]
): { ledger: PrincipalLedger; principal: Map<EarnAsset, bigint>; changed: boolean } {
  const next: PrincipalLedger = { ...ledger };
  const principal = new Map<EarnAsset, bigint>();
  let changed = false;

  for (const code of allCodes) {
    const key = keyFor(code);
    const balance = balances.find((b) => b.code === code);
    if (!balance) {
      if (key in next) {
        delete next[key];
        changed = true;
      }
      continue;
    }
    if (!(key in next)) {
      next[key] = balance.valueStroops.toString();
      changed = true;
    }
    principal.set(code, BigInt(next[key]));
  }
  return { ledger: next, principal, changed };
}

export async function syncPrincipal(
  network: string,
  address: string,
  balances: SavingsBalance[],
  allCodes: EarnAsset[]
): Promise<Map<EarnAsset, bigint>> {
  const ledger = await loadLedger();
  const result = reconcileLedger(ledger, balances, (code) => principalKey(network, address, code), allCodes);
  if (result.changed) await saveLedger(result.ledger);
  return result.principal;
}

/** Record money added through Savings. `before` is the position's value just before the deposit. */
export async function recordAdded(
  network: string,
  address: string,
  code: EarnAsset,
  before: bigint,
  added: bigint
): Promise<void> {
  const ledger = await loadLedger();
  const key = principalKey(network, address, code);
  const existing = key in ledger ? BigInt(ledger[key]) : before;
  ledger[key] = (existing + added).toString();
  await saveLedger(ledger);
}

/** Forget the principal once an asset is fully taken out. */
export async function recordTakenOut(network: string, address: string, code: EarnAsset): Promise<void> {
  const ledger = await loadLedger();
  const key = principalKey(network, address, code);
  if (!(key in ledger)) return;
  delete ledger[key];
  await saveLedger(ledger);
}

/** What was earned, never below zero (a position can read a hair under principal after rounding). */
export function earnedStroops(valueStroops: bigint, principalStroops: bigint): bigint {
  const earned = valueStroops - principalStroops;
  return earned > 0n ? earned : 0n;
}
