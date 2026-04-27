const LENS_BASE_URL = process.env.NEXT_PUBLIC_LENS_URL ?? 'https://lens-ldtu.onrender.com'
const TIMEOUT_MS    = 5_000

function assetParam(code: string, issuer: string | null | undefined): string {
  if (code === 'XLM') return 'native'
  if (!issuer) return code
  return `${code}:${issuer}`
}

/**
 * Fetch the USDC price of a single asset from the Lens oracle.
 *
 * Returns null on any error (402, network timeout, unknown asset).
 * This is intentionally a best-effort call — callers must handle null gracefully.
 *
 * Lens uses x402 micropayment gating. In the wallet context the request is
 * attempted without payment; a 402 response is treated as "price unavailable"
 * (the same as a timeout or network error) rather than blocking the UI.
 */
export async function fetchPrice(
  code:   string,
  issuer: string | null | undefined,
): Promise<number | null> {
  const assetA = assetParam(code, issuer)
  // Quote everything in USDC (testnet USDC issuer)
  const assetB = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
  const url    = `${LENS_BASE_URL}/price/${encodeURIComponent(assetA)}/${encodeURIComponent(assetB)}`

  const controller = new AbortController()
  const timerId    = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(url, { signal: controller.signal })
    // 402 = payment required, 404 = unknown pair — both are graceful no-price
    if (!res.ok) return null
    const data = await res.json() as Record<string, unknown>
    // Lens may return price under different field names
    const price = data.price ?? data.ask ?? data.last ?? data.close
    return typeof price === 'number' ? price : null
  } catch {
    return null  // AbortError (timeout), NetworkError, parse error
  } finally {
    clearTimeout(timerId)
  }
}

/**
 * Fetch prices for multiple assets concurrently.
 * Returns a map from asset key to price (or null if unavailable).
 * Asset key format: "XLM" for native, "CODE:ISSUER" for others.
 */
export async function fetchPrices(
  assets: Array<{ code: string; issuer: string | null }>,
): Promise<Record<string, number | null>> {
  const results = await Promise.allSettled(
    assets.map(async ({ code, issuer }) => {
      const price = await fetchPrice(code, issuer)
      const key   = issuer ? `${code}:${issuer}` : code
      return { key, price }
    }),
  )

  return results.reduce<Record<string, number | null>>((acc, r) => {
    if (r.status === 'fulfilled') acc[r.value.key] = r.value.price
    return acc
  }, {})
}
