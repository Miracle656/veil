import { BASE_FEE } from '@stellar/stellar-sdk';
import type { VeilNetwork, VeilNetworkName } from './network';

/**
 * Inclusion-fee bid (stroops, per operation) for building transactions.
 *
 * Mainnet surge-prices inclusion — the Soroban lane especially — and the
 * 100-stroop BASE_FEE gets rejected outright with txINSUFFICIENT_FEE.
 *
 * Overbidding is safe on Stellar: the ledger charges the effective market
 * rate, not the bid, so a generous mainnet bid (0.1 XLM = 1,000,000 stroops)
 * costs approximately nothing in practice while surviving surges. Testnet keeps
 * the standard minimum.
 */
export function inclusionFee(network?: VeilNetworkName | VeilNetwork): string {
  const name = typeof network === 'object' && network !== null ? network.name : network;
  return name === 'mainnet' ? '1000000' : BASE_FEE;
}
