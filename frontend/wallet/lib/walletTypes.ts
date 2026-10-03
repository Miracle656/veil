/**
 * Shared wallet data types used across multiple pages and library modules.
 *
 * Keeping these here avoids circular imports between lib/ modules and the
 * app/ page components that previously defined them inline.
 */

/** A token balance visible on the fee-payer or wallet contract account. */
export interface WalletAsset {
  code: string
  issuer: string | null
  balance: string
}
