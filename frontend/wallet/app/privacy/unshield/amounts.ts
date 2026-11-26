/**
 * The arithmetic and the asset list behind the unshield screen.
 *
 * Separate from `page.tsx` so it can be tested without rendering, which is how
 * `app/swap/direction.ts` and `app/earn/prefill.ts` are arranged.
 */

import { getSppConfig } from '@/lib/privacy/config'
import type { VeilNetworkName } from '@/lib/network'

/**
 * What can actually be withdrawn.
 *
 * Derived from the pools the project pins in `lib/privacy/config.ts`, never
 * from a list written by hand. Both configured testnet pools are
 * `assetKind: 'native'`, so XLM is the only answer today — offering USDC or
 * EURC would offer a pool that does not exist, and nobody can unshield from
 * one of those.
 */
export function withdrawableAssetCodes(network: VeilNetworkName): string[] {
  const pools = getSppConfig(network)?.pools ?? []
  const codes = new Set<string>()
  for (const pool of pools) if (pool.assetKind === 'native') codes.add('XLM')
  return [...codes]
}

/**
 * XLM as typed, to stroops as the pool counts them.
 *
 * Returns null rather than NaN or a silent truncation: `parseFloat` accepts
 * `"1.2.3"`, `"1e9"` and `"  12abc"`, and this value decides how much money
 * leaves a shielded pool.
 */
export function xlmToStroops(value: string): bigint | null {
  const trimmed = value.trim()
  if (!/^\d+(\.\d{1,7})?$/.test(trimmed)) return null
  const [whole, fraction = ''] = trimmed.split('.')
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0'))
}

/** Stroops back to a display string, without trailing zeros. */
export function stroopsToXlm(value: bigint): string {
  const whole = value / 10_000_000n
  const fraction = (value % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : `${whole}`
}
