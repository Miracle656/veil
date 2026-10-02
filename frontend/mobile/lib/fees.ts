import { BASE_FEE } from '@stellar/stellar-sdk';

import { getNetwork } from './network';

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
