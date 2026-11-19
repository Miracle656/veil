/**
 * Live liquidity gate for buying tokenized sovereign debt (#1062).
 *
 * The registry can say an asset is real and can be held; it cannot say whether
 * anyone is on the other side of the trade today. KTB, EUROB and GILTS are
 * genuine Etherfuse bonds with no authorization flags and, between them, one
 * bid and no asks: a user who bought one would hold something with no way out.
 * That is the single worst outcome this rail can produce, so the buy path asks
 * the live book first.
 *
 * An asset that fails is not hidden — it can still be held, displayed and sold.
 * It simply cannot be bought through Veil, and says why in one sentence.
 *
 * Fails closed: a Horizon error refuses the buy rather than allowing it.
 */

import { horizonAssetType, type RegisteredAsset } from './assets'

/**
 * Minimum resting amount required on *each* side of the book before an asset
 * may be bought, in the bond's own units (the base asset of the book).
 *
 * This is not a size ceiling and not a price: it is the smallest book the rail
 * is willing to let someone buy into, knowing they must be able to sell back
 * out. A side thinner than this is a trap dressed as a listing. Named rather
 * than inlined because the three live bonds (CETES, USTRY, TESOURO) sit above
 * it and the three thin ones (KTB, EUROB, GILTS) below it, and the number
 * should be reviewable when that changes.
 */
export const MIN_BOND_BOOK_DEPTH = 5

export interface BookLevel {
  price?: string
  amount?: string
}

export interface OrderBookLike {
  bids?: BookLevel[]
  asks?: BookLevel[]
}

export type LiquidityVerdict =
  | { ok: true; bidDepth: number; askDepth: number }
  | { ok: false; reason: string }

/** The refusal sentence used when the book cannot be read at all. */
export const LIQUIDITY_UNAVAILABLE_REASON =
  "Veil could not read the live market for this bond, so it cannot be bought here right now."

/** The refusal sentence used when the book is one-sided or empty. */
export const ILLIQUID_REASON =
  'This bond has offers on only one side of the market right now, so there is no way back out and it cannot be bought here.'

function depth(levels: BookLevel[] | undefined): number {
  if (!Array.isArray(levels)) return 0
  let total = 0
  for (const level of levels) {
    const amount = Number(level?.amount)
    if (Number.isFinite(amount) && amount > 0) total += amount
  }
  return total
}

/**
 * Decides whether anything may be bought against this book. A one-sided or
 * empty book is illiquidity, not an error — the reason names illiquidity so a
 * user is never shown a raw failure instead.
 */
export function assessBondLiquidity(book: OrderBookLike | null | undefined): LiquidityVerdict {
  if (!book) return { ok: false, reason: LIQUIDITY_UNAVAILABLE_REASON }
  const bidDepth = depth(book.bids)
  const askDepth = depth(book.asks)
  if (bidDepth <= 0 || askDepth <= 0) return { ok: false, reason: ILLIQUID_REASON }
  if (bidDepth < MIN_BOND_BOOK_DEPTH || askDepth < MIN_BOND_BOOK_DEPTH) {
    return {
      ok: false,
      reason: 'The market for this bond is too thin to buy into, so it cannot be bought here until it deepens.',
    }
  }
  return { ok: true, bidDepth, askDepth }
}

export interface LiquidityFetchDeps {
  horizonUrl: string
  /** The USDC issuer this network quotes in. */
  quoteIssuer: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * The `asset_type` Horizon needs for a given code. Kept here so a long
 * (credit_alphanum12) bond code is never queried as a four-character one,
 * which would return an empty book rather than an error.
 */
export function orderBookAssetType(code: string): 'credit_alphanum4' | 'credit_alphanum12' {
  return horizonAssetType(code)
}

/**
 * Reads the live USDC book for `asset` and applies {@link assessBondLiquidity}.
 * A failed request, a non-2xx response or an unreadable body all refuse the buy
 * (fail closed) rather than letting it through.
 */
export async function fetchBondLiquidity(
  asset: Pick<RegisteredAsset, 'code' | 'issuer'>,
  deps: LiquidityFetchDeps,
): Promise<LiquidityVerdict> {
  const assetType = orderBookAssetType(asset.code)
  const url =
    `${deps.horizonUrl}/order_book` +
    `?selling_asset_type=${assetType}` +
    `&selling_asset_code=${encodeURIComponent(asset.code)}` +
    `&selling_asset_issuer=${encodeURIComponent(asset.issuer)}` +
    `&buying_asset_type=credit_alphanum4&buying_asset_code=USDC` +
    `&buying_asset_issuer=${encodeURIComponent(deps.quoteIssuer)}` +
    `&limit=20`

  const fetchImpl = deps.fetchImpl ?? fetch
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(deps.timeoutMs ?? 5_000) })
    if (!res.ok) return assessBondLiquidity(null)
    const book = (await res.json()) as OrderBookLike
    return assessBondLiquidity(book)
  } catch {
    return assessBondLiquidity(null)
  }
}
