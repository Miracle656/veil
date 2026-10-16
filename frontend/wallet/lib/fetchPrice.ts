import { isRegisteredIssuer } from './assets'
import { getNetwork, getUsdcIssuer } from './network'

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
    if (!res.ok) return orderBookPrice(code, issuer)
    const data = (await res.json()) as Record<string, unknown>
    // Lens may return price under different field names
    const price = data.price ?? data.ask ?? data.last ?? data.close
    if (typeof price === 'number') return price
    return orderBookPrice(code, issuer)
  } catch {
    // AbortError (timeout), NetworkError, parse error — the oracle is simply
    // not answering, which is not a reason to show no price at all.
    return orderBookPrice(code, issuer)
  } finally {
    clearTimeout(timerId)
  }
}

/**
 * The live mid of the SDEX book between this asset and Circle's USDC.
 *
 * Ported from `frontend/mobile/lib/fetchPrice.ts`, where it has existed for a
 * while — and where it is the reason the mobile app kept pricing balances
 * through a Lens outage that left this one blank.
 *
 * Lens stays the preferred source: it is volume-weighted across venues, where
 * this is the top of one book. But an unreachable oracle should cost accuracy,
 * not the number entirely. Nothing sits behind this — no key, no database, no
 * RPC quota — it is the same Horizon the wallet already reads balances from.
 *
 * Deliberately not a constant. A plausible-looking hardcoded fallback (0.11 XLM)
 * once valued 5.35 XLM at $0.59 against a real $0.99, and went stale the day it
 * was written.
 */
async function orderBookPrice(
  code: string,
  issuer: string | null | undefined,
): Promise<number | null> {
  const { horizonUrl } = getNetwork()
  const quoteIssuer = getUsdcIssuer()

  const selling =
    code.toUpperCase() === 'XLM' || !issuer
      ? 'selling_asset_type=native'
      : `selling_asset_type=${code.length > 4 ? 'credit_alphanum12' : 'credit_alphanum4'}` +
        `&selling_asset_code=${encodeURIComponent(code)}` +
        `&selling_asset_issuer=${encodeURIComponent(issuer)}`

  const url =
    `${horizonUrl}/order_book?${selling}` +
    `&buying_asset_type=credit_alphanum4&buying_asset_code=USDC` +
    `&buying_asset_issuer=${encodeURIComponent(quoteIssuer)}&limit=1`

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) return null
    const book = (await res.json()) as { bids?: { price?: string }[]; asks?: { price?: string }[] }
    const bid = Number(book.bids?.[0]?.price)
    const ask = Number(book.asks?.[0]?.price)
    // Both sides required: a one-sided book has no mid, and taking whichever
    // side exists would quote a price nobody is willing to trade against.
    if (!isFinite(bid) || !isFinite(ask) || bid <= 0 || ask <= 0) return null
    return (bid + ask) / 2
  } catch {
    return null
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
