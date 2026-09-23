import { inclusionFee as sdkInclusionFee } from '@veil/sdk'
import { getNetwork } from './network'

/**
 * Inclusion-fee bid (stroops, per operation) for building transactions.
 *
 * Mainnet surge-prices inclusion — the Soroban lane especially — and the
 * 100-stroop BASE_FEE gets rejected outright with txINSUFFICIENT_FEE.
 *
 * The bid itself comes from @veil/sdk: 0.01 XLM on mainnet. It must stay
 * affordable, because an account has to cover its whole bid above its reserve
 * or the network rejects the transaction with tx_insufficient_balance.
 * Testnet keeps the minimum.
 */
export function inclusionFee(): string {
  return sdkInclusionFee(getNetwork())
}

