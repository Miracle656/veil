/**
 * One row per asset in a Blend pool.
 *
 * A pool lends several assets and each has its own rate. Earn used to show
 * one figure per pool, the plain average of them all, and then deposited the
 * pool's first asset. On 2026-11-28 that put "2.24% APY" on a pool where USDC
 * earned 6.47% and XLM, the asset actually deposited by default, earned 0%.
 *
 * So there is no pool-wide rate here at all. A rate belongs to an asset, and
 * every figure on the screen is read from the row for the asset being
 * deposited.
 */
import { Asset } from '@stellar/stellar-sdk'

import { ASSET_REGISTRY } from './assets'

export interface BlendReserve {
  /** The asset's contract id. This, not the code, is what identifies it. */
  asset: string
  /** The asset's code when the contract id is one Veil has verified, else null. */
  code: string | null
  /** Estimated yearly supply rate, e.g. 0.0647 for 6.47%. */
  supplyApy: number
  /** Total supplied, in whole units of the asset. */
  totalSupplied: number
}

/**
 * The code for a contract id, from the verified registry only. The pool's own
 * metadata is not trusted for this: anyone can deploy a token that calls
 * itself USDC, and the contract id is what tells them apart.
 */
export function verifiedCodeForContract(
  contractId: string,
  network: 'mainnet' | 'testnet',
  networkPassphrase: string,
): string | null {
  try {
    if (Asset.native().contractId(networkPassphrase) === contractId) return 'XLM'
  } catch {
    /* fall through */
  }
  for (const asset of Object.values(ASSET_REGISTRY)) {
    if (!asset.issuer) continue
    if (asset.network !== 'all' && asset.network !== network) continue
    try {
      if (new Asset(asset.code, asset.issuer).contractId(networkPassphrase) === contractId) return asset.code
    } catch {
      /* a registry row that is not a valid asset cannot match */
    }
  }
  return null
}

/** The row for an asset, or null when the pool does not lend it. */
export function reserveFor(reserves: readonly BlendReserve[], assetContract: string | null | undefined): BlendReserve | null {
  if (!assetContract) return null
  return reserves.find((r) => r.asset === assetContract) ?? null
}

/** What to call a reserve on screen: its verified code, or the whole contract id. */
export function reserveLabel(reserve: Pick<BlendReserve, 'asset' | 'code'>): string {
  return reserve.code ?? reserve.asset
}

/** "6.47%". A rate that is not a finite number is shown as a dash, never as 0. */
export function formatApy(apy: number | null | undefined): string {
  if (typeof apy !== 'number' || !Number.isFinite(apy)) return '—'
  return `${(apy * 100).toFixed(2)}%`
}

/**
 * Estimated earnings over a year on an amount, as a string, or null when
 * there is nothing honest to show (no rate, or no amount).
 */
export function yearlyEarnings(amount: string, apy: number | null | undefined): string | null {
  const value = Number.parseFloat(amount)
  if (!Number.isFinite(value) || value <= 0) return null
  if (typeof apy !== 'number' || !Number.isFinite(apy)) return null
  return (value * apy).toFixed(4)
}
