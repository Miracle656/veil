/**
 * Portfolio summary (issue #740).
 *
 * Converts raw wallet assets + Blend lending positions + a live price map into
 * a structured portfolio view: total value in USD, split by kind (cash,
 * lending, invest), with per-line share of the total and a "priced at"
 * timestamp.
 *
 * Design rules:
 *  - A failed quote is represented as `null` — never coerced to zero. An
 *    unpriced line shows `valueUsd: null`, `status: 'unavailable'`, and is
 *    excluded from all totals. Stale quotes are NOT yet distinguished from
 *    failed ones: there is no staleness logic yet, so a Lens outage and a
 *    stale quote both surface as 'unavailable'. `priceAvailable` is kept for
 *    one release as a deprecated alias of `status !== 'unavailable'`.
 *  - Totals are the arithmetic sum of the included lines, to the same floating-
 *    point precision, so they always reconcile with the displayed figures.
 *  - A lending position whose underlying contract cannot be resolved to a
 *    code/issuer pair is reported with `status: 'unresolved'` — still visible,
 *    never valued, so the total cannot silently drop it.
 *  - Classification is issuer-checked. A code alone is not an asset: mainnet
 *    has eight assets called USDT0 and seven are impostors. Unverified assets
 *    land in `invest` — labelled in the UI as unverified — rather than being
 *    presented as cash.
 *  - The `pricedAt` timestamp records when the caller collected the prices.
 *    Callers must pass the moment prices were collected (cached prices must
 *    carry the time they were fetched), not the time the component renders.
 */

import type { WalletAsset } from '@/lib/walletTypes'
import type { BlendPosition } from '@/lib/blend'
import { getAssetIssuer, KNOWN_SAC_CONTRACT_IDS, verifiedAsset } from './assets'
import { getNetworkName } from './network'

// ── Asset kind classification ─────────────────────────────────────────────────

/**
 * The three portfolio buckets shown in the summary card.
 *
 * - `cash`    — verified dollar pegs and native XLM held on the fee-payer
 * - `lending` — tokens deposited into a lending/yield pool (Blend supply positions)
 * - `invest`  — yield-bearing or treasury tokens, and every asset that is not
 *               a verified dollar peg
 */
export type AssetKind = 'cash' | 'lending' | 'invest'

/**
 * Portfolio kind for a wallet asset, judged by ISSUER, not code.
 *
 * A verified stablecoin/treasury entry gets its registry kind; a counterfeit
 * "USDC" from any other issuer is not cash — it defaults to `invest` so it is
 * never presented to the user as a dollar. XLM (no issuer) is native cash.
 * Mirrors `verifiedAsset`: the registry is the source of truth for what is a
 * dollar, and it keys on the exact issuer address.
 */
export function classifyAsset(
  code: string,
  issuer: string | null | undefined,
  network: 'mainnet' | 'testnet' = 'mainnet',
): AssetKind {
  if (!issuer) {
    // Native XLM is the only issuerless asset the wallet tracks.
    return code.toUpperCase() === 'XLM' ? 'cash' : 'invest'
  }
  const registered = verifiedAsset(code, issuer, network)
  if (registered) {
    switch (registered.kind) {
      case 'stablecoin':
        return 'cash'
      case 'treasury':
      case 'fund':
      case 'equity':
        return 'invest'
      default:
        return 'invest'
    }
  }
  // Not in the verified registry: an unknown or counterfeit asset. It is not a
  // dollar, so it never lands in cash — `invest` with an "unverified" label in
  // the UI keeps the total honest without pretending to know what it is.
  return 'invest'
}

// ── Core types ────────────────────────────────────────────────────────────────

/** One row in the portfolio breakdown. */
export interface PortfolioLine {
  /** Display code of the underlying asset. */
  code: string
  /**
   * Stellar issuer, or null for XLM. For lending positions: the underlying
   * Soroban contract ID (unresolved positions) or its issuer (resolved ones).
   */
  issuer: string | null
  /** Human-readable category. */
  kind: AssetKind
  /**
   * How the display label relates to a verified asset: `native` (XLM),
   * `verified` (code + issuer in the registry), or `unverified` (everything
   * else — the UI must say so).
   */
  verification: 'native' | 'verified' | 'unverified'
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
   * Quote status for this line.
   * - `priced`       — a live quote came back
   * - `unavailable`  — no quote (Lens outage, unknown pair). Staleness is NOT
   *                    detected yet; a stale quote also lands here.
   * - `unresolved`   — the asset could not be mapped to a priceable key
   */
  status: 'priced' | 'unavailable' | 'unresolved'
  /**
   * @deprecated Superseded by `status`. True unless the quote is unavailable;
   * `false` never distinguished staleness — there is no staleness logic yet.
   * Kept so existing callers keep compiling; remove in the next minor.
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

// ── Pricing-key resolution ────────────────────────────────────────────────────

function assetKey(code: string, issuer: string | null): string {
  return issuer ? `${code}:${issuer}` : code
}

/** Shape of the optional fourth argument to `buildPortfolio`. */
export interface PortfolioOptions {
  /** Network the registry is judged against. Defaults to the wallet's active network. */
  network?: 'mainnet' | 'testnet'
  /**
   * Map from Soroban contract ID → price map key ("CODE:ISSUER") for lending
   * positions. Callers that loaded Blend reserves can resolve their reserve
   * asset IDs exactly; anything missing falls back to the verified SAC map
   * (`KNOWN_SAC_CONTRACT_IDS`).
   */
  contractKeys?: Record<string, string>
}

/**
 * Resolve a Blend position's underlying contract ID to the price-map key
 * ("XLM" or "CODE:ISSUER") and a display label, or null when it cannot be
 * resolved. Only verified assets are ever resolved — the caller's
 * `contractKeys` is trusted for the pool's own reserves; the fallback map is
 * keyed by registered code by construction.
 */
function resolveLendingPriceKey(
  contractId: string,
  opts: { network: 'mainnet' | 'testnet'; contractKeys: Record<string, string> },
): { key: string; code: string; issuer: string | null } | null {
  const mapped = opts.contractKeys[contractId]
  if (mapped) {
    // "CODE:ISSUER" or "XLM"
    const sep = mapped.indexOf(':')
    if (sep === -1) {
      if (mapped.toUpperCase() === 'XLM') return { key: 'XLM', code: 'XLM', issuer: null }
    } else {
      const code = mapped.slice(0, sep)
      const issuer = mapped.slice(sep + 1)
      if (verifiedAsset(code, issuer, opts.network)) {
        return { key: mapped, code, issuer }
      }
      // A caller-supplied mapping that is not issuer-verified is ignored:
      // trusting it would let a pool rename its reserve into a dollar.
      return null
    }
    return null
  }
  for (const [code, sac] of Object.entries(KNOWN_SAC_CONTRACT_IDS[opts.network])) {
    if (sac === contractId) {
      const issuer = getAssetIssuer(code, opts.network)
      if (issuer && verifiedAsset(code, issuer, opts.network)) {
        return { key: assetKey(code, issuer), code, issuer }
      }
    }
  }
  return null
}

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Build a `PortfolioSummary` from raw wallet data.
 *
 * @param walletAssets  Assets visible on the fee-payer account (XLM, USDC, …).
 * @param positions     Active Blend supply positions (lending bucket).
 * @param prices        Map from asset key → USD price (or null = unavailable).
 *                      Key format: `"XLM"` for native, `"CODE:ISSUER"` for others.
 * @param pricedAt      Epoch ms when `prices` was collected. A cached map must
 *                      carry the time it was fetched, not the render time.
 * @param opts          Network for registry lookups and, optionally, explicit
 *                      contract-ID → price-key mappings for Blend reserves.
 */
export function buildPortfolio(
  walletAssets: WalletAsset[],
  positions: BlendPosition[],
  prices: Record<string, number | null>,
  pricedAt: number,
  opts: PortfolioOptions = {},
): PortfolioSummary {
  const network = opts.network ?? getNetworkName()
  const contractKeys = opts.contractKeys ?? {}
  const lines: PortfolioLine[] = []

  function pushLine(line: Omit<PortfolioLine, 'share' | 'priceAvailable'>) {
    lines.push({
      ...line,
      share: null, // filled in below once we have the total
      priceAvailable: line.status !== 'unavailable',
    })
  }

  // ── Cash + invest assets from the wallet ──────────────────────────────────
  for (const asset of walletAssets) {
    const amount = parseFloat(asset.balance)
    if (!isFinite(amount) || amount <= 0) continue

    const key = assetKey(asset.code, asset.issuer)
    const price = prices[key] ?? null
    const native = asset.issuer === null && asset.code.toUpperCase() === 'XLM'
    const verification: PortfolioLine['verification'] = native
      ? 'native'
      : verifiedAsset(asset.code, asset.issuer, network)
        ? 'verified'
        : 'unverified'

    pushLine({
      code: asset.code,
      issuer: asset.issuer,
      kind: classifyAsset(asset.code, asset.issuer, network),
      verification,
      amount: asset.balance,
      valueUsd: price !== null ? amount * price : null,
      status: price !== null ? 'priced' : 'unavailable',
    })
  }

  // ── Lending positions from Blend ──────────────────────────────────────────
  // Blend stores amounts in stroops (7 decimal places). Positions are priced
  // through the *underlying* reserve asset, which must resolve to a verified
  // code:issuer pair — see resolveLendingPriceKey. Unresolvable positions stay
  // visible with status 'unresolved' and never contribute to any total.
  for (const pos of positions) {
    const stroops = BigInt(pos.deposited)
    if (stroops <= 0n) continue

    const amount = Number(stroops) / 10_000_000
    const resolved = resolveLendingPriceKey(pos.asset, { network, contractKeys })

    if (resolved) {
      const price = prices[resolved.key] ?? null
      pushLine({
        code: resolved.code,
        issuer: resolved.issuer,
        kind: 'lending',
        verification: 'verified',
        amount: amount.toFixed(7),
        valueUsd: price !== null ? amount * price : null,
        status: price !== null ? 'priced' : 'unavailable',
      })
    } else {
      pushLine({
        code: pos.asset.length > 12 ? pos.asset.slice(0, 6) + '…' + pos.asset.slice(-4) : pos.asset,
        issuer: pos.asset,
        kind: 'lending',
        verification: 'unverified',
        amount: amount.toFixed(7),
        valueUsd: null,
        status: 'unresolved',
      })
    }
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
