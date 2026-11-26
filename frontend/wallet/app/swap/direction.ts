/**
 * Direction-flip rules for the swap form.
 *
 * Kept beside the page rather than inside it so they can be unit-tested: the
 * page module imports @stellar/stellar-sdk, whose minified bundle does not load
 * under the wallet's jsdom Jest environment.
 *
 * Assets are matched by code AND issuer throughout (#793): two assets can share
 * a code — mainnet has eight called USDT0 — and flipping one into the other
 * would trade something the user never picked.
 */

import type { SwapAsset } from '@/lib/swapAssets'

export interface StellarAsset {
  code: string
  issuer?: string
  balance: string
}

/** code:issuer, or `native` for XLM — the only identity two assets can share. */
export function assetKey(a: { code: string; issuer?: string | null }): string {
  return a.issuer ? `${a.code}:${a.issuer}` : 'native'
}

/** The receive-side form of a swap asset. */
export function toDestAsset(a: SwapAsset): StellarAsset {
  return a.issuer ? { code: a.code, issuer: a.issuer, balance: '0' } : { code: 'XLM', balance: '0' }
}

/**
 * What flipping the swap direction would produce, or null when the pair cannot
 * be flipped — the receive picker only offers `destinations`, and the pay side
 * needs an asset the account actually holds, since every quote is priced
 * against a balance. Returning null keeps the toggle disabled instead of
 * leaving the form in a state the quote effect silently refuses to price.
 */
export function resolveFlip(
  source: StellarAsset | null | undefined,
  dest: StellarAsset,
  balances: StellarAsset[],
  destinations: SwapAsset[],
): { nextSource: StellarAsset; nextDest: StellarAsset } | null {
  if (!source) return null
  const nextDest = destinations.find((d) => assetKey(d) === assetKey(source))
  if (!nextDest) return null
  const nextSource = balances.find((b) => assetKey(b) === assetKey(dest))
  if (!nextSource) return null
  return { nextSource, nextDest: toDestAsset(nextDest) }
}

/** A swap the agent handed over: `/swap?from=XLM&to=USDC&amount=10`. */
export interface SwapPrefill {
  from?: string
  to?: string
  amount?: string
}

/**
 * Reads a hand-off from the query string. Anything malformed is dropped rather
 * than guessed at, so a bad link opens the ordinary empty form: codes must be
 * short uppercase tickers and the amount a plain positive number with at most
 * seven decimals (Stellar's precision).
 */
export function parseSwapPrefill(search: string): SwapPrefill {
  const q = new URLSearchParams(search)
  const code = (v: string | null) => {
    const c = v?.trim().toUpperCase()
    return c && /^[A-Z0-9]{1,12}$/.test(c) ? c : undefined
  }
  const amount = q.get('amount')?.trim()
  return {
    from: code(q.get('from')),
    to: code(q.get('to')),
    amount: amount && /^\d+(\.\d{1,7})?$/.test(amount) && Number(amount) > 0 ? amount : undefined,
  }
}
