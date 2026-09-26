/**
 * Direction-flip rules for the swap form.
 *
 * Kept beside the page rather than inside it so they can be unit-tested: the
 * page module imports @stellar/stellar-sdk, whose minified bundle does not load
 * under the wallet's jsdom Jest environment.
 */

export interface StellarAsset {
  code: string
  issuer?: string
  balance: string
}

/** The receive side of the form offers these two assets only. */
export const DEST_CODES = ['USDC', 'XLM'] as const

/** Builds the receive-side asset for a code the picker offers. */
export function makeDestAsset(code: string, usdcIssuer?: string): StellarAsset {
  return code === 'XLM'
    ? { code: 'XLM', balance: '0' }
    : { code: 'USDC', issuer: usdcIssuer, balance: '0' }
}

/**
 * What flipping the swap direction would produce, or null when the pair cannot
 * be flipped — the receive picker only offers DEST_CODES, and the pay side
 * needs an asset the account actually holds, since every quote is priced
 * against a balance. Returning null keeps the toggle disabled instead of
 * leaving the form in a state the quote effect silently refuses to price.
 */
export function resolveFlip(
  sourceCode: string | undefined,
  destCode: string,
  balances: StellarAsset[],
  usdcIssuer?: string,
): { nextSource: StellarAsset; nextDest: StellarAsset } | null {
  if (!sourceCode || !(DEST_CODES as readonly string[]).includes(sourceCode)) return null
  const nextSource = balances.find((b) => b.code === destCode)
  if (!nextSource) return null
  return { nextSource, nextDest: makeDestAsset(sourceCode, usdcIssuer) }
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
