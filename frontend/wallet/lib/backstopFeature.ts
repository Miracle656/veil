/**
 * Build/network gate for the Blend backstop screen (#1298).
 *
 * Backstopping is first-loss capital: a mistake is not a reverted transaction,
 * it is money that can be taken to cover a pool's bad debt. The screen therefore
 * stays dark on mainnet until the live testnet cycle has actually been run, and
 * only a build that explicitly opts in can expose it there.
 *
 * This module holds no `@stellar/stellar-sdk` or Blend SDK imports and no
 * module-scope side effects, so the navigation and the route guard can ask
 * "is the backstop available here?" without pulling the signing path into the
 * shared app-shell bundle — the same reason `lib/multisigConfig.ts` is shaped
 * this way.
 */
import { getNetworkName, type VeilNetworkName } from './network'

/**
 * Build-time opt-in, spelled out literally because Next.js inlines
 * `NEXT_PUBLIC_*` by matching the member expression in the source; a computed
 * key reads as `undefined` in the browser (see `lib/privacy/config.ts`).
 */
function backstopFlagOn(): boolean {
  return (
    process.env.NEXT_PUBLIC_BLEND_BACKSTOP_FEATURE_FLAG === '1' ||
    process.env.NEXT_PUBLIC_BLEND_BACKSTOP_FEATURE_FLAG === 'true'
  )
}

/**
 * Whether `/backstop` is reachable on `network`, defaulting to the active one.
 *
 * Off on mainnet unless the build opts in with
 * `NEXT_PUBLIC_BLEND_BACKSTOP_FEATURE_FLAG=1`. Testnet is where the live cycle
 * runs, so it is available there without extra configuration.
 */
export function isBackstopEnabled(network: VeilNetworkName = getNetworkName()): boolean {
  if (network === 'mainnet') return backstopFlagOn()
  return true
}
