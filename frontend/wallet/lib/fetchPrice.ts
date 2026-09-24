import { isRegisteredIssuer } from './assets'
import { getUsdcIssuer } from './network'

const LENS_BASE_URL = process.env.NEXT_PUBLIC_LENS_URL ?? 'https://lens-ldtu.onrender.com'
const TIMEOUT_MS = 5_000

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
 * Dollar stablecoins (USDC, verified USDT0) are treated as 1.0.
 * An impostor USDT0 is routed by code:issuer to the oracle/SDEX, never treated as 1.0.
 */
export async function fetchPrice(
  code: string,
  issuer: string | null | undefined,
): Promise<number | null> {
  const upper = code.toUpperCase()
  if (upper === 'USDC' && (!issuer || isRegisteredIssuer('USDC', issuer))) return 1.0
  if (upper === 'USDT0' && (!issuer || isRegisteredIssuer('USDT0', issuer, 'mainnet'))) return 1.0

  const assetA = assetParam(code, issuer)
  // Quote everything in USDC, using whichever issuer is canonical here.
  const assetB = `USDC:${getUsdcIssuer()}`
  const url = `${LENS_BASE_URL}/price/${encodeURIComponent(assetA)}/${encodeURIComponent(assetB)}`

  const controller = new AbortController()
  const timerId = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(url, { signal: controller.signal })
    // 402 = payment required, 404 = unknown pair — both are graceful no-price
    if (!res.ok) return null
    const data = (await res.json()) as Record<string, unknown>
    // Lens may return price under different field names
    const price = data.price ?? data.ask ?? data.last ?? data.close
    return typeof price === 'number' ? price : null
  } catch {
    return null // AbortError (timeout), NetworkError, parse error
  } finally {
    clearTimeout(timerId)
  }
}

/**
 * The fiat value of a balance at a given price, or `null` when the price is
 * unavailable. Handles 7-decimal place precision.
 */
export function usdValue(balance: string | number, price: number | null): number | null {
  if (price == null) return null
  const amount = typeof balance === 'number' ? balance : parseFloat(balance)
  if (!isFinite(amount)) return null
  return amount * price
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
      const key = issuer ? `${code}:${issuer}` : code
      return { key, price }
    }),
  )

  return results.reduce<Record<string, number | null>>((acc, r) => {
    if (r.status === 'fulfilled') acc[r.value.key] = r.value.price
    return acc
  }, {})
}
