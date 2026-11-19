/**
 * AMM Liquidity Pool (LP) position recognition and valuation.
 *
 * Stellar AMM LP tokens arrive on a Horizon account's `balances` array with
 * `asset_type: 'liquidity_pool_shares'` and a `liquidity_pool_id` (no
 * `asset_code` or `asset_issuer`). They are positions representing a share of
 * a two-asset pool, NEVER plain asset balances — and must never be summed into
 * a plain asset balance.
 *
 * This module must stay IMPORT-FREE: it is mirrored byte-for-byte in
 * `frontend/mobile/lib/lpPositions.ts` and verified by parity tests on both
 * clients so mobile and web always report the exact same positions and values
 * for the same wallet.
 */

// ── Horizon wire shapes ───────────────────────────────────────────────────────

/** Minimal Horizon account balance entry needed to separate plain assets from LP shares. */
export interface HorizonBalanceEntry {
  asset_type: string
  balance: string
  asset_code?: string
  asset_issuer?: string
  liquidity_pool_id?: string
  limit?: string
}

/** One reserve leg on a Horizon `/liquidity_pools/{id}` record. */
export interface HorizonPoolReserve {
  /** `"native"` for XLM or `"CODE:ISSUER"` for issued assets. */
  asset: string
  amount: string
}

/** Minimal Horizon liquidity pool record (`/liquidity_pools/{id}`). */
export interface HorizonLiquidityPoolRecord {
  id: string
  fee_bp: number
  total_shares: string
  total_trustlines?: string
  reserves: HorizonPoolReserve[]
  last_modified_ledger?: number
  last_modified_time?: string
}

// ── Domain types ──────────────────────────────────────────────────────────────

/** A non-zero LP share holding extracted from a Horizon account's balances. */
export interface RawLpShare {
  poolId: string
  shares: string
}

/** One underlying asset leg of a resolved LP position. */
export interface LpUnderlyingAsset {
  code: string
  issuer: string | null
  /** Canonical price-map key: `"XLM"` for native, `"CODE:ISSUER"` for issued assets. */
  priceKey: string
  /** User's pro-rata amount of this underlying asset, to 7 decimal places. */
  amount: string
  /** USD value of this leg when a valid price was provided, otherwise null. */
  valueUsd: number | null
}

export type LpPositionStatus = 'known' | 'unknown_pair'

/** A user's AMM liquidity pool position, labelled and valued in underlying terms. */
export interface LpPosition {
  /** 64-character hex Horizon liquidity pool ID. */
  poolId: string
  /** Raw LP share balance held by the wallet. */
  shares: string
  /** Total shares issued by the pool, or null when the pool record is unavailable. */
  totalShares: string | null
  /** Fraction of the pool owned (`shares / totalShares`, 0–1), or null when unavailable. */
  shareOfPool: number | null
  /** Pool swap fee in basis points (e.g. 30 = 0.30%), or null when unavailable. */
  feeBp: number | null
  /** Display pair label (e.g. `"XLM / USDC"`), or `"Unknown pair"` when unresolved. */
  pair: string
  /** Pro-rata underlying reserves for both legs, or null for unknown pairs. */
  underlying: [LpUnderlyingAsset, LpUnderlyingAsset] | null
  /**
   * Combined USD value of both underlying legs when BOTH legs are priced;
   * null when either leg is unpriced or the pair is unknown. Never fabricates
   * a partial USD total as if it were the full position value.
   */
  valueUsd: number | null
  /** `'known'` when pool reserves resolved cleanly; `'unknown_pair'` otherwise. */
  status: LpPositionStatus
}

// ── Separation helpers ────────────────────────────────────────────────────────

/** True when a Horizon balance entry is an AMM LP share line, not a plain asset. */
export function isLpShareBalance(entry: Pick<HorizonBalanceEntry, 'asset_type'>): boolean {
  return entry.asset_type === 'liquidity_pool_shares'
}

/**
 * Filter raw Horizon `account.balances` to plain asset balances only (native
 * XLM and classic `credit_alphanum4` / `credit_alphanum12` trustlines).
 *
 * LP share entries are ALWAYS excluded so an LP position can never leak into
 * or be summed into a plain asset balance.
 */
export function filterPlainAssetBalances<T extends HorizonBalanceEntry>(balances: T[]): T[] {
  return balances.filter(
    (b) =>
      b.asset_type === 'native' ||
      ((b.asset_type === 'credit_alphanum4' || b.asset_type === 'credit_alphanum12') &&
        Boolean(b.asset_code) &&
        Boolean(b.asset_issuer)),
  )
}

/**
 * Extract held (strictly positive) LP share balances from a Horizon account's
 * `balances` array. Zero-share trustlines are excluded.
 */
export function parseLpShares(balances: HorizonBalanceEntry[]): RawLpShare[] {
  const byPool = new Map<string, number>()
  const rawByPool = new Map<string, string>()

  for (const entry of balances) {
    if (!isLpShareBalance(entry)) continue
    const poolId = entry.liquidity_pool_id?.trim()
    if (!poolId) continue

    const amount = Number(entry.balance)
    if (!Number.isFinite(amount) || amount <= 0) continue

    const prev = byPool.get(poolId)
    if (prev === undefined) {
      byPool.set(poolId, amount)
      rawByPool.set(poolId, entry.balance)
    } else {
      const next = prev + amount
      byPool.set(poolId, next)
      rawByPool.set(poolId, next.toFixed(7))
    }
  }

  return Array.from(rawByPool.entries()).map(([poolId, shares]) => ({
    poolId,
    shares,
  }))
}

// ── Reserve parsing & position valuation ──────────────────────────────────────

/** Parse a Horizon pool reserve asset string (`"native"` or `"CODE:ISSUER"`). */
export function parsePoolReserveAsset(
  ref: string,
): { code: string; issuer: string | null; priceKey: string } | null {
  if (!ref || typeof ref !== 'string') return null
  const trimmed = ref.trim()
  if (trimmed === 'native') {
    return { code: 'XLM', issuer: null, priceKey: 'XLM' }
  }
  const parts = trimmed.split(':')
  if (parts.length !== 2) return null
  const [code, issuer] = parts
  if (!code || !issuer) return null
  return { code, issuer, priceKey: `${code}:${issuer}` }
}

function validPrice(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function unknownPairPosition(share: RawLpShare): LpPosition {
  return {
    poolId: share.poolId,
    shares: share.shares,
    totalShares: null,
    shareOfPool: null,
    feeBp: null,
    pair: 'Unknown pair',
    underlying: null,
    valueUsd: null,
    status: 'unknown_pair',
  }
}

/**
 * Resolve one held LP share balance against its Horizon liquidity pool record
 * and an optional USD price map (`"XLM"` / `"CODE:ISSUER"` → USD).
 *
 * When the pool record is missing, has invalid reserves, or has non-positive
 * total shares, returns an `'unknown_pair'` position so the holding remains
 * visible without inventing a pair or value.
 */
export function resolveLpPosition(
  share: RawLpShare,
  pool: HorizonLiquidityPoolRecord | null | undefined,
  prices: Record<string, number | null> = {},
): LpPosition {
  const sharesNum = Number(share.shares)
  if (!Number.isFinite(sharesNum) || sharesNum <= 0) {
    return unknownPairPosition(share)
  }
  if (!pool || !Array.isArray(pool.reserves) || pool.reserves.length < 2) {
    return unknownPairPosition(share)
  }

  const totalSharesNum = Number(pool.total_shares)
  if (!Number.isFinite(totalSharesNum) || totalSharesNum <= 0) {
    return unknownPairPosition(share)
  }

  const [reserveA, reserveB] = pool.reserves
  const assetA = parsePoolReserveAsset(reserveA.asset)
  const assetB = parsePoolReserveAsset(reserveB.asset)
  const reserveANum = Number(reserveA.amount)
  const reserveBNum = Number(reserveB.amount)

  if (
    !assetA ||
    !assetB ||
    !Number.isFinite(reserveANum) ||
    !Number.isFinite(reserveBNum) ||
    reserveANum < 0 ||
    reserveBNum < 0
  ) {
    return unknownPairPosition(share)
  }

  const shareOfPool = sharesNum / totalSharesNum
  const underlyingANum = shareOfPool * reserveANum
  const underlyingBNum = shareOfPool * reserveBNum

  const priceA = validPrice(prices[assetA.priceKey])
  const priceB = validPrice(prices[assetB.priceKey])
  const valueUsdA = priceA !== null ? underlyingANum * priceA : null
  const valueUsdB = priceB !== null ? underlyingBNum * priceB : null
  const valueUsd = valueUsdA !== null && valueUsdB !== null ? valueUsdA + valueUsdB : null

  return {
    poolId: share.poolId,
    shares: share.shares,
    totalShares: pool.total_shares,
    shareOfPool,
    feeBp: typeof pool.fee_bp === 'number' && Number.isFinite(pool.fee_bp) ? pool.fee_bp : null,
    pair: `${assetA.code} / ${assetB.code}`,
    underlying: [
      {
        code: assetA.code,
        issuer: assetA.issuer,
        priceKey: assetA.priceKey,
        amount: underlyingANum.toFixed(7),
        valueUsd: valueUsdA,
      },
      {
        code: assetB.code,
        issuer: assetB.issuer,
        priceKey: assetB.priceKey,
        amount: underlyingBNum.toFixed(7),
        valueUsd: valueUsdB,
      },
    ],
    valueUsd,
    status: 'known',
  }
}

/**
 * Resolve all held LP positions from a Horizon account's `balances`, a map of
 * pool ID → Horizon pool record, and an optional USD price map.
 *
 * Output is deterministically sorted:
 *  1. Priced known positions by `valueUsd` descending
 *  2. Unpriced known positions by `pair` ascending, then `poolId` ascending
 *  3. Unknown-pair positions by `poolId` ascending
 */
export function resolveLpPositions(
  balances: HorizonBalanceEntry[],
  poolsById: Record<string, HorizonLiquidityPoolRecord | null | undefined>,
  prices: Record<string, number | null> = {},
): LpPosition[] {
  const shares = parseLpShares(balances)
  const resolved = shares.map((share) =>
    resolveLpPosition(share, poolsById[share.poolId], prices),
  )

  resolved.sort((a, b) => {
    if (a.valueUsd !== null && b.valueUsd !== null) {
      if (b.valueUsd !== a.valueUsd) return b.valueUsd - a.valueUsd
      return a.poolId.localeCompare(b.poolId)
    }
    if (a.valueUsd !== null) return -1
    if (b.valueUsd !== null) return 1
    if (a.status !== b.status) return a.status === 'known' ? -1 : 1
    const pairCmp = a.pair.localeCompare(b.pair)
    if (pairCmp !== 0) return pairCmp
    return a.poolId.localeCompare(b.poolId)
  })

  return resolved
}

/**
 * Fetch a single Horizon liquidity pool record by ID. Returns `null` on 404 or
 * any network/parse error so the caller degrades gracefully to `unknown_pair`.
 */
export async function fetchHorizonLiquidityPool(
  horizonUrl: string,
  poolId: string,
  fetchFn: typeof fetch = fetch,
): Promise<HorizonLiquidityPoolRecord | null> {
  try {
    const base = horizonUrl.replace(/\/+$/, '')
    const res = await fetchFn(`${base}/liquidity_pools/${encodeURIComponent(poolId)}`)
    if (!res.ok) return null
    const record = (await res.json()) as HorizonLiquidityPoolRecord
    if (!record || typeof record.id !== 'string' || !Array.isArray(record.reserves)) {
      return null
    }
    return record
  } catch {
    return null
  }
}

/**
 * End-to-end loader: extracts held LP shares from Horizon balances, fetches
 * any pool records not already present in `knownPools`, and resolves every
 * held position against `prices`.
 */
export async function loadLpPositions(
  balances: HorizonBalanceEntry[],
  fetchPool: (poolId: string) => Promise<HorizonLiquidityPoolRecord | null>,
  prices: Record<string, number | null> = {},
  knownPools: Record<string, HorizonLiquidityPoolRecord> = {},
): Promise<LpPosition[]> {
  const shares = parseLpShares(balances)
  if (shares.length === 0) return []

  const poolsById: Record<string, HorizonLiquidityPoolRecord | null> = { ...knownPools }
  const missingIds = shares
    .map((s) => s.poolId)
    .filter((id) => !(id in poolsById))

  await Promise.all(
    missingIds.map(async (id) => {
      try {
        poolsById[id] = await fetchPool(id)
      } catch {
        poolsById[id] = null
      }
    }),
  )

  return resolveLpPositions(balances, poolsById, prices)
}

/**
 * Collect unique underlying `{ code, issuer }` pairs from resolved LP positions
 * so callers can request USD prices for assets the user only holds inside pools.
 */
export function collectLpPriceTargets(
  positions: LpPosition[],
): Array<{ code: string; issuer: string | null }> {
  const seen = new Map<string, { code: string; issuer: string | null }>()
  for (const pos of positions) {
    if (!pos.underlying) continue
    for (const leg of pos.underlying) {
      if (!seen.has(leg.priceKey)) {
        seen.set(leg.priceKey, { code: leg.code, issuer: leg.issuer })
      }
    }
  }
  return Array.from(seen.values())
}

// ── Display formatting helpers ────────────────────────────────────────────────

/** Format a numeric string with up to `maxFractionDigits` decimals, trimming trailing zeros. */
export function formatLpAmount(value: string | number, maxFractionDigits = 4): string {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return '0'
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFractionDigits,
  })
}

/** Format a pool share ratio (0–1) as a human-readable percentage string. */
export function formatPoolSharePct(shareOfPool: number | null): string {
  if (shareOfPool === null || !Number.isFinite(shareOfPool) || shareOfPool < 0) return '—'
  const pct = shareOfPool * 100
  if (pct > 0 && pct < 0.01) return '<0.01%'
  return `${pct.toFixed(2)}%`
}

/** Format a position's underlying value (e.g. `"500 XLM + 50 USDC"`). */
export function formatUnderlyingValue(position: LpPosition, maxFractionDigits = 4): string {
  if (!position.underlying) return 'Underlying pair unavailable'
  const [a, b] = position.underlying
  return `${formatLpAmount(a.amount, maxFractionDigits)} ${a.code} + ${formatLpAmount(b.amount, maxFractionDigits)} ${b.code}`
}

/** Shorten a 64-char Horizon liquidity pool ID for compact UI labels. */
export function shortPoolId(poolId: string): string {
  return poolId.length > 16 ? `${poolId.slice(0, 8)}…${poolId.slice(-6)}` : poolId
}
