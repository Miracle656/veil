/**
 * Pre-build fee-payer balance check — issue #820 — and the dashboard funding
 * banner (V193 / #766).
 *
 * Every Soroban transaction needs a funded G… fee-payer. When the fee-payer
 * account is empty (or doesn't exist at all) the failure used to arrive at
 * submission as a cryptic network error. This module catches it BEFORE signing,
 * with a message that names the exact amount needed and the address to send
 * it to.
 *
 * Two failure modes, each with its own error class:
 *   • `FeePayerNotFunded` — the account does not exist on the network at all.
 *     Remedy: fund it with at least the base reserve + fees.
 *   • `FeePayerShort` — the account exists but its free balance (after the
 *     reserve and liabilities) is below the fee bid.
 *     Remedy: top up the difference.
 *
 * Usage: call `assertFeePayerCanCoverFee(address)` before building any
 * transaction. It is async (Horizon round-trip) and throws one of the two
 * errors, or resolves silently when the account is healthy.
 *
 * The dashboard banner shares `queryFeePayerBalance` with that guard, so the
 * Horizon read, reserve maths, and liabilities handling stay in one place.
 */

import { Horizon, Keypair } from '@stellar/stellar-sdk';

import { feeBidXlm } from './fees';
import { getNetwork } from './network';
import { getSignerSecret } from './walletStore';

// ── Error classes ────────────────────────────────────────────────────────────

/**
 * The fee-payer G… address has never been funded — `loadAccount` returns 404.
 * The remedy is to create the account with a `create_account` op or Friendbot
 * (testnet), not just a payment.
 */
export class FeePayerNotFunded extends Error {
  readonly feePayerAddress: string;
  readonly neededXlm: number;

  constructor(feePayerAddress: string, neededXlm: number) {
    super(
      `Your fee-payer account does not exist on the network yet. ` +
        `Send at least ${neededXlm} XLM to ${feePayerAddress} to activate it.`,
    );
    this.name = 'FeePayerNotFunded';
    this.feePayerAddress = feePayerAddress;
    this.neededXlm = neededXlm;
  }
}

/**
 * The fee-payer exists but its spendable balance (balance − reserve −
 * liabilities) is too low to cover the inclusion-fee bid.
 */
export class FeePayerShort extends Error {
  readonly feePayerAddress: string;
  readonly haveXlm: number;
  readonly neededXlm: number;

  constructor(feePayerAddress: string, haveXlm: number, neededXlm: number) {
    super(
      `Your fee-payer account has ${haveXlm.toFixed(7)} XLM available, ` +
        `but at least ${neededXlm} XLM is needed to cover the network fee. ` +
        `Send ${(neededXlm - haveXlm).toFixed(7)} XLM to ${feePayerAddress} to continue.`,
    );
    this.name = 'FeePayerShort';
    this.feePayerAddress = feePayerAddress;
    this.haveXlm = haveXlm;
    this.neededXlm = neededXlm;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Minimum XLM a fee-payer needs free (above reserve) to submit one tx. */
export function feePayerMinimumXlm(): number {
  // The bid itself, plus a small buffer for the Soroban resource fee that is
  // charged on top of the inclusion bid.
  return feeBidXlm() + 0.01;
}

export type FeePayerBalance =
  | { exists: false }
  | {
      exists: true;
      /** Native XLM the account holds. */
      balance: number;
      /** Subentries counted toward the reserve. */
      subentries: number;
      /** `(2 + subentries) × 0.5`. */
      reserve: number;
      /** Selling liabilities locking native XLM. */
      sellingLiabilities: number;
      /** Balance − reserve − liabilities. Never negative. */
      spendableXlm: number;
    };

/**
 * Load the fee-payer's Horizon account and return its XLM breakdown. This is
 * extracted so callers that want to inspect the value without throwing can use
 * it directly.
 *
 * @returns `{ exists: true, ... }` or `{ exists: false }` on a 404. A failed
 *          read (network error, timeout) is reported as an infinite spendable
 *          balance: unknown, not empty, so a flaky Horizon never blocks a send
 *          that would have gone through.
 */
export async function queryFeePayerBalance(
  feePayerAddress: string,
  horizonUrl?: string,
): Promise<FeePayerBalance> {
  const url = horizonUrl ?? getNetwork().horizonUrl;
  const server = new Horizon.Server(url);

  try {
    const account = await server.loadAccount(feePayerAddress);
    const native = (
      account.balances as Array<{
        asset_type: string;
        balance: string;
        selling_liabilities?: string;
      }>
    ).find((b) => b.asset_type === 'native');
    const balance = Number(native?.balance ?? '0');
    const subentries = Number(
      (account as unknown as { subentry_count?: number }).subentry_count ?? 0,
    );
    const reserve = (2 + subentries) * 0.5;
    const liabilities = Number(native?.selling_liabilities ?? '0');
    const spendableXlm = Math.max(0, balance - reserve - liabilities);
    return {
      exists: true,
      balance,
      subentries,
      reserve,
      sellingLiabilities: liabilities,
      spendableXlm,
    };
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404 || (err instanceof Error && err.name === 'NotFoundError')) {
      return { exists: false };
    }
    return {
      exists: true,
      balance: 0,
      subentries: 0,
      reserve: 0,
      sellingLiabilities: 0,
      spendableXlm: Number.POSITIVE_INFINITY,
    };
  }
}

/**
 * Assert the fee-payer can cover the fee bid. Throws `FeePayerNotFunded` or
 * `FeePayerShort` when it cannot; resolves silently when it can. Call this
 * before building any transaction.
 *
 * @param feePayerAddress The `G…` address that pays the fee.
 * @param horizonUrl      Optional Horizon URL override (tests).
 */
export async function assertFeePayerCanCoverFee(
  feePayerAddress: string,
  horizonUrl?: string,
): Promise<void> {
  const needed = feePayerMinimumXlm();
  const result = await queryFeePayerBalance(feePayerAddress, horizonUrl);

  if (!result.exists) {
    throw new FeePayerNotFunded(feePayerAddress, needed);
  }

  if (result.spendableXlm < needed) {
    throw new FeePayerShort(feePayerAddress, result.spendableXlm, needed);
  }
}

// ── Fee-payer funding banner (V193 / #766) ───────────────────────────────────

/**
 * Small fee buffer held above the reserve so a freshly funded fee-payer can
 * actually submit. Mirrors the buffer in `contractSpend.getFeePayerXlm`.
 */
export const FEE_PAYER_FEE_BUFFER_XLM = 0.05;

/** Stellar base reserve per entry (2 base entries + subentries). */
export const BASE_RESERVE_XLM = 0.5;

/** Minimum XLM an account must hold: `(2 + subentries) × 0.5`. */
export function requiredReserveXlm(subentries: number): number {
  return (2 + Math.max(0, Math.floor(subentries))) * BASE_RESERVE_XLM;
}

/** Minimum XLM a fee-payer must hold to be usable: reserve + fee buffer. */
export function requiredFeePayerXlm(subentries: number): number {
  return requiredReserveXlm(subentries) + FEE_PAYER_FEE_BUFFER_XLM;
}

export type FeePayerFundingInput = {
  /** `false` when Horizon has no account at all (404). */
  exists: boolean;
  /** Native XLM balance; 0 when missing. */
  balance?: number;
  /** Subentry count; 0 when missing. */
  subentries?: number;
  /** Selling liabilities locking native XLM; 0 when none. */
  sellingLiabilities?: number;
};

export type FeePayerFundingAssessment = {
  status: 'missing' | 'underfunded' | 'healthy';
  /** What the account holds (0 when missing). */
  balance: number;
  /** Subentries counted toward the reserve. */
  subentries: number;
  /** `(2 + subentries) × 0.5`. */
  reserve: number;
  /** Reserve + fee buffer: the concrete amount the banner names. */
  needed: number;
  /** `needed - effective balance`; 0 when healthy. Never negative. */
  shortfall: number;
};

/**
 * Pure assessment of fee-payer funding — the unit-testable core of the
 * dashboard banner. A missing account and a funded-but-too-low account both
 * need funding; only a healthy one does not.
 */
export function assessFeePayerFunding(input: FeePayerFundingInput): FeePayerFundingAssessment {
  if (!input.exists) {
    const reserve = requiredReserveXlm(0);
    const needed = requiredFeePayerXlm(0);
    return { status: 'missing', balance: 0, subentries: 0, reserve, needed, shortfall: needed };
  }
  const balance = Number.isFinite(input.balance ?? 0) ? Number(input.balance) : 0;
  const subentries = Math.max(0, Math.floor(input.subentries ?? 0));
  const liabilities = Math.max(0, Number(input.sellingLiabilities ?? 0) || 0);
  const reserve = requiredReserveXlm(subentries);
  const needed = requiredFeePayerXlm(subentries);
  const effective = balance - liabilities;
  if (effective < needed) {
    return {
      status: 'underfunded',
      balance,
      subentries,
      reserve,
      needed,
      shortfall: Math.max(0, needed - effective),
    };
  }
  return { status: 'healthy', balance, subentries, reserve, needed, shortfall: 0 };
}

export type FeePayerFundingState =
  | {
      status: 'missing' | 'underfunded' | 'healthy';
      feePayerAddress: string;
      balance: number;
      subentries: number;
      reserve: number;
      needed: number;
      shortfall: number;
    }
  | { status: 'unknown' | 'no-wallet'; feePayerAddress: string | null };

/**
 * Check the stored fee-payer's funding against reserve + fee buffer.
 *
 * - `missing`: Horizon 404 — the account does not exist yet.
 * - `underfunded`: exists but holds less than reserve + fee buffer.
 * - `healthy`: can pay fees.
 * - `unknown`: Horizon unreachable — deliberately not a banner, so a failed
 *   lookup never reads as a broken wallet.
 * - `no-wallet`: no fee-payer stored on this device (nothing to check).
 */
export async function checkFeePayerFunding(): Promise<FeePayerFundingState> {
  let feePayer: string | null = null;
  try {
    const secret = await getSignerSecret();
    feePayer = secret ? Keypair.fromSecret(secret).publicKey() : null;
  } catch {
    return { status: 'unknown', feePayerAddress: null };
  }
  if (!feePayer) return { status: 'no-wallet', feePayerAddress: null };

  const result = await queryFeePayerBalance(feePayer);
  if (!result.exists) {
    return { ...assessFeePayerFunding({ exists: false }), feePayerAddress: feePayer };
  }
  // An infinite spendable balance is `queryFeePayerBalance`'s "read failed"
  // sentinel. For the pre-send guard that errs safe, but a banner must not
  // claim health from a Horizon it could not reach.
  if (!Number.isFinite(result.spendableXlm)) {
    return { status: 'unknown', feePayerAddress: feePayer };
  }
  return {
    ...assessFeePayerFunding({
      exists: true,
      balance: result.balance,
      subentries: result.subentries,
      sellingLiabilities: result.sellingLiabilities,
    }),
    feePayerAddress: feePayer,
  };
}
