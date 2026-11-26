import { BASE_FEE } from '@stellar/stellar-sdk';
import type { VeilNetwork, VeilNetworkName } from './network';

/**
 * Inclusion-fee bid (stroops, per operation) for building transactions.
 *
 * Mainnet surge-prices inclusion — the Soroban lane especially — and the
 * 100-stroop BASE_FEE gets rejected outright with txINSUFFICIENT_FEE.
 *
 * The ledger charges the effective market rate, not the bid, but an account
 * must cover its whole bid above its reserve or the transaction is rejected
 * with tx_insufficient_balance. A 0.1 XLM bid made every account keep 0.1 XLM
 * spare; 0.01 XLM (100,000 stroops) still clears mainnet's p99 charged fee
 * (62,324 stroops, Horizon fee_stats 2026-09-14). Testnet keeps the standard
 * minimum.
 */
export function inclusionFee(network?: VeilNetworkName | VeilNetwork): string {
  const name = typeof network === 'object' && network !== null ? network.name : network;
  return name === 'mainnet' ? '100000' : BASE_FEE;
}
