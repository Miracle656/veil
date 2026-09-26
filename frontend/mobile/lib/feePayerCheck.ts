/**
 * Pre-build fee-payer balance check — issue #820.
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
 */

import { Horizon } from '@stellar/stellar-sdk';

import { feeBidXlm } from './fees';
import { getNetwork } from './network';

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

/**
 * Load the fee-payer's Horizon account and return its spendable XLM. This is
 * extracted so callers that want to inspect the value without throwing can use
 * it directly.
 *
 * @returns `{ exists: true, spendableXlm }` or `{ exists: false }`.
 */
export async function queryFeePayerBalance(
  feePayerAddress: string,
  horizonUrl?: string,
): Promise<{ exists: true; spendableXlm: number } | { exists: false }> {
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
    return { exists: true, spendableXlm };
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404 || (err instanceof Error && err.name === 'NotFoundError')) {
      return { exists: false };
    }
    // Network errors, timeouts, etc. — let the caller (or the eventual
    // submission) surface the real problem rather than a false "short".
    throw err;
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
