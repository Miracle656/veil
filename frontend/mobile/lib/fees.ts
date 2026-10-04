import { BASE_FEE, Horizon, Keypair } from '@stellar/stellar-sdk';

import { getNetwork } from './network';
import { getSignerSecret } from './walletStore';

/**
 * Inclusion-fee bid (stroops, per operation) for building transactions.
 *
 * Mainnet surge-prices inclusion — especially the Soroban lane — and the
 * 100-stroop BASE_FEE gets rejected with txINSUFFICIENT_FEE (bitten first on
 * the factory deploy, then on the first in-app SAC transfer). So mainnet bids
 * above the market; the ledger charges the effective rate, not the bid.
 *
 * The bid is not free to make, though. An account must be able to cover its
 * whole bid above its reserve, or the network rejects the transaction outright
 * with tx_insufficient_balance, even though only a sliver of it would have been
 * charged. The previous bid of 0.1 XLM meant a spending account needed 0.1 XLM
 * spare to send anything at all — the likeliest cause of a tester's cash-out
 * failing that way while their USDC was there.
 *
 * 0.01 XLM (100,000 stroops) still sits well above what mainnet charges:
 * Horizon fee_stats on 2026-09-14 gave fee_charged p50 100, p90 9,486 and p99
 * 62,324 stroops. Testnet keeps the minimum.
 */
export const MAINNET_FEE_BID = '100000';

export function inclusionFee(): string {
  return getNetwork().name === 'mainnet' ? MAINNET_FEE_BID : BASE_FEE;
}

/** The bid in XLM, for checking an account can afford it before building anything. */
export function feeBidXlm(): number {
  return Number(inclusionFee()) / 10_000_000;
}

// ── Fee-payer funding (V193 / #766) ──────────────────────────────────────────

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

/** Format an XLM amount with a concrete figure for the banner (e.g. `1.05 XLM`). */
export function formatFundingXlm(amount: number): string {
  return `${amount.toFixed(2)} XLM`;
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

function isAccountNotFound(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  return status === 404 || (err instanceof Error && err.name === 'NotFoundError');
}

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

  try {
    const server = new Horizon.Server(getNetwork().horizonUrl);
    const account = await server.loadAccount(feePayer);
    const native = (
      account.balances as Array<{
        asset_type: string;
        balance: string;
        selling_liabilities?: string;
      }>
    ).find((b) => b.asset_type === 'native');
    const subentries = Number(
      (account as unknown as { subentry_count?: number }).subentry_count ?? 0,
    );
    const assessed = assessFeePayerFunding({
      exists: true,
      balance: Number(native?.balance ?? '0'),
      subentries: Number.isFinite(subentries) ? subentries : 0,
      sellingLiabilities: Number(native?.selling_liabilities ?? '0'),
    });
    return { ...assessed, feePayerAddress: feePayer };
  } catch (err) {
    if (isAccountNotFound(err)) {
      const assessed = assessFeePayerFunding({ exists: false });
      return { ...assessed, feePayerAddress: feePayer };
    }
    return { status: 'unknown', feePayerAddress: feePayer };
  }
}
