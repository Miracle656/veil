/**
 * Portfolio summary (issue #740).
 *
 * Converts raw wallet assets + Blend lending positions + a live price map into
 * a structured portfolio view: total value in USD, split by kind (cash,
 * lending, invest), with per-line share of the total and a "priced at"
 * timestamp.
 *
 * Design rules:
 *  - A stale or failed quote is represented as `null` — never coerced to zero.
 *    An unpriced line shows `valueUsd: null` and is excluded from all totals.
 *  - Totals are the arithmetic sum of the included lines, to the same floating-
 *    point precision, so they always reconcile with the displayed figures.
 *  - The `pricedAt` timestamp records when the caller collected the prices.
 *    Callers must pass `Date.now()` at the moment prices are collected, not
 *    the time the component renders.
 */

import type { WalletAsset } from '@/lib/walletTypes'
import type { BlendPosition } from '@/lib/blend'

// ── Asset kind classification ─────────────────────────────────────────────────

/**
 * The three portfolio buckets shown in the summary card.
 *
 * - `cash`    — USDC, XLM, stablecoins, and native assets held on the fee-payer
 * - `lending` — tokens deposited into a lending/yield pool (Blend supply positions)
 * - `invest`  — yield-bearing tokens held directly (USDY, funds, equities)
 */
export type AssetKind = 'cash' | 'lending' | 'invest'

/**
 * Returns the portfolio kind for a wallet asset.
 * XLM and USDC are cash; known yield/treasury tokens are invest; unknown assets
 * default to cash (the conservative assumption).
 */
export function classifyAsset(code: string, _issuer: string | null): AssetKind {
  const c = code.toUpperCase()
  // Stablecoins and native
  if (c === 'XLM' || c === 'USDC' || c === 'EURC' || c === 'NGNC') return 'cash'
  // Yield-bearing tokens held in the wallet
  if (c === 'USDY' || c === 'USDM' || c === 'BRLX') return 'invest'
  // Everything else is treated as cash so the total is never understated
  return 'cash'
}

// ── Core types ────────────────────────────────────────────────────────────────

/** One row in the portfolio breakdown. */
export interface PortfolioLine {
  /** Display code of the underlying asset. */
  code: string
  /** Stellar issuer, or null for XLM. */
  issuer: string | null
  /** Human-readable category. */
  kind: AssetKind
  /** Token amount held (or deposited, for lending positions). */
  amount: string
  /** USD value at the provided price; null when the price was unavailable. */
  valueUsd: number | null
  /**
   * Share of the wallet total (0–1). Null when this line or the total is
   * unpriced — a partial denominator would produce a meaningless percentage.
   */
  share: number | null
  /**
   * True when the price came from the live Lens feed (or was the USDC
   * hardcoded value of 1.0). False is not currently set — the field exists so
   * a future stale-price signal from the oracle can be surfaced without a
   * breaking API change.
   */
  priceAvailable: boolean
}

/** The full portfolio roll-up returned by `buildPortfolio`. */
export interface PortfolioSummary {
  /** All lines, sorted by valueUsd descending (nulls last). */
  lines: PortfolioLine[]
  /** Sum of all priced lines in USD. Null when no asset has a price. */
  totalUsd: number | null
  /** USD total for the cash bucket. Null if no cash asset was priced. */
  cashUsd: number | null
  /** USD total for the lending bucket. Null if no lending position was priced. */
  lendingUsd: number | null
  /** USD total for the invest bucket. Null if no invest asset was priced. */
  investUsd: number | null
  /** Epoch ms when the caller collected the prices. */
  pricedAt: number
}

// ── Builder ───────────────────────────────────────────────────────────────────

function assetKey(code: string, issuer: string | null): string {
  return issuer ? `${code}:${issuer}` : code
}

/**
 * Build a `PortfolioSummary` from raw wallet data.
 *
 * @param walletAssets  Assets visible on the fee-payer account (XLM, USDC, …).
 * @param positions     Active Blend supply positions (lending bucket).
 * @param prices        Map from asset key → USD price (or null = unavailable).
 *                      Key format: `"XLM"` for native, `"CODE:ISSUER"` for others.
 * @param pricedAt      Epoch ms when `prices` was collected.
 */
export function buildPortfolio(
  walletAssets: WalletAsset[],
  positions: BlendPosition[],
  prices: Record<string, number | null>,
  pricedAt: number,
): PortfolioSummary {
  const lines: PortfolioLine[] = []

  // ── Cash + invest assets from the wallet ──────────────────────────────────
  for (const asset of walletAssets) {
    const amount = parseFloat(asset.balance)
    if (!isFinite(amount) || amount <= 0) continue

    const kind = classifyAsset(asset.code, asset.issuer)
    const key = assetKey(asset.code, asset.issuer)
    const price = prices[key] ?? null
    const valueUsd = price !== null ? amount * price : null

    lines.push({
      code: asset.code,
      issuer: asset.issuer,
      kind,
      amount: asset.balance,
      valueUsd,
      share: null, // filled in below once we have the total
      priceAvailable: price !== null,
    })
  }

  // ── Lending positions from Blend ──────────────────────────────────────────
  // Blend stores amounts in stroops (7 decimal places).
  for (const pos of positions) {
    const stroops = BigInt(pos.deposited)
    if (stroops <= 0n) continue

    const amount = Number(stroops) / 10_000_000

    // pos.asset is the Soroban contract ID of the underlying token. We cannot
    // map every contract to a code/issuer pair here, so we store the raw
    // contract as the issuer and leave the code as the short prefix for display.
    const code = pos.asset.length > 10 ? pos.asset.slice(0, 6) + '…' : pos.asset
    const key = pos.asset // Blend positions use the contract ID as the price key

    // Try looking up by contract ID first, then fall back to a known short code.
    const price = prices[key] ?? null
    const valueUsd = price !== null ? amount * price : null

    lines.push({
      code,
      issuer: pos.asset,
      kind: 'lending' as AssetKind,
      amount: amount.toFixed(7),
      valueUsd,
      share: null,
      priceAvailable: price !== null,
    })
  }

  // ── Compute totals ────────────────────────────────────────────────────────
  const pricedLines = lines.filter((l) => l.valueUsd !== null)
  const totalUsd    = pricedLines.length > 0
    ? pricedLines.reduce((sum, l) => sum + (l.valueUsd as number), 0)
    : null

  // Fill in share for each line, only when we have a valid total
  if (totalUsd !== null && totalUsd > 0) {
    for (const line of lines) {
      if (line.valueUsd !== null) {
        line.share = line.valueUsd / totalUsd
      }
    }
  }

  // Bucket totals
  function bucketTotal(kind: AssetKind): number | null {
    const bucket = pricedLines.filter((l) => l.kind === kind)
    if (bucket.length === 0) return null
    return bucket.reduce((sum, l) => sum + (l.valueUsd as number), 0)
  }

  // Sort: priced lines by value descending, unpriced lines at the end
  lines.sort((a, b) => {
    if (a.valueUsd !== null && b.valueUsd !== null) return b.valueUsd - a.valueUsd
    if (a.valueUsd !== null) return -1
    if (b.valueUsd !== null) return 1
    return 0
  })

  return {
    lines,
    totalUsd,
    cashUsd:    bucketTotal('cash'),
    lendingUsd: bucketTotal('lending'),
    investUsd:  bucketTotal('invest'),
    pricedAt,
  }
}
