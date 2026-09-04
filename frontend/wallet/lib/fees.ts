import { inclusionFee as sdkInclusionFee } from '@veil/sdk'
import { getNetwork } from './network'

/**
 * Inclusion-fee bid (stroops, per operation) for building transactions.
 *
 * Mainnet surge-prices inclusion — the Soroban lane especially — and the
 * 100-stroop BASE_FEE gets rejected outright with txINSUFFICIENT_FEE.
 *
 * Overbidding is safe on Stellar: the ledger charges the effective market
 * rate, not the bid, so a generous mainnet bid (0.1 XLM) costs approximately
 * nothing in practice while surviving surges. Testnet keeps the minimum.
 */
export function inclusionFee(): string {
  return sdkInclusionFee(getNetwork())
}

