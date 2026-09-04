/**
 * A rolling record of the wallet's fiat total, so the balance header can show a
 * 24h change.
 *
 * Lens serves a spot price and nothing historical, so the figure shown is the
 * change in what the wallet is worth, not an asset price move — a deposit reads
 * as a gain. That is the conventional reading for a balance header, but it is
 * worth knowing which number it is.
 *
 * Totals are stored in USD, the currency they are computed in, so changing the
 * display currency cannot corrupt the history. Keys are scoped by network and
 * address: a testnet total must never be read back as a mainnet one.
 */

export interface BalanceSnapshot {
  /** Epoch milliseconds. */
  t: number
  /** Wallet total in USD at that moment. */
  usd: number
}

/** Snapshots older than this are dropped; nothing reads past 24h today. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** One snapshot an hour is enough resolution and keeps the entry small. */
const MIN_INTERVAL_MS = 60 * 60 * 1000
const WINDOW_MS = 24 * 60 * 60 * 1000

export function historyKey(network: string, address: string): string {
  return `veil_balance_history:${network}:${address}`
}

function isSnapshot(v: unknown): v is BalanceSnapshot {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Record<string, unknown>
  return typeof s.t === 'number' && Number.isFinite(s.t)
    && typeof s.usd === 'number' && Number.isFinite(s.usd)
}

/** Drops malformed, future-dated and expired entries, oldest first. */
export function pruneSnapshots(
  snapshots: BalanceSnapshot[],
  now: number,
  maxAgeMs: number = MAX_AGE_MS,
): BalanceSnapshot[] {
  return snapshots
    .filter((s) => isSnapshot(s) && now - s.t <= maxAgeMs && now - s.t >= 0)
    .sort((a, b) => a.t - b.t)
}

/**
 * Adds `usd` to the history unless the newest entry is still fresh. Returns the
 * pruned list either way, so the caller can write back unconditionally.
 */
export function recordSnapshot(
  snapshots: BalanceSnapshot[],
  usd: number,
  now: number,
  minIntervalMs: number = MIN_INTERVAL_MS,
): BalanceSnapshot[] {
  const kept = pruneSnapshots(snapshots, now)
  if (!Number.isFinite(usd)) return kept
  const newest = kept[kept.length - 1]
  if (newest && now - newest.t < minIntervalMs) return kept
  return [...kept, { t: now, usd }]
}

/**
 * Percentage change against the most recent snapshot that is already a full
 * window old — anything newer would understate the move. Null when there is no
 * such snapshot yet, which is what keeps the chip hidden on a wallet that has
 * been open for less than a day.
 */
export function change24h(
  snapshots: BalanceSnapshot[],
  currentUsd: number,
  now: number,
  windowMs: number = WINDOW_MS,
): number | null {
  if (!Number.isFinite(currentUsd)) return null
  const past = snapshots
    .filter((s) => isSnapshot(s) && now - s.t >= windowMs)
    .sort((a, b) => b.t - a.t)[0]
  if (!past || past.usd <= 0) return null
  return ((currentUsd - past.usd) / past.usd) * 100
}

/**
 * Whether a total may be compared with a stored one.
 *
 * `fetchPrice` hardcodes USDC to 1.0 and returns null for everything else it
 * cannot reach, so a price-feed outage does not produce "no total" — it
 * produces a total with the unpriced assets silently dropped. Comparing that
 * against yesterday's full total reports the outage as a loss. Lens is
 * currently returning 503, which makes this the ordinary path, not an edge
 * case.
 */
export function isComparableTotal(assetCount: number, pricedCount: number): boolean {
  return assetCount > 0 && pricedCount === assetCount
}

export function readHistory(key: string): BalanceSnapshot[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isSnapshot) : []
  } catch {
    // Unparseable, or storage blocked entirely (private mode). Either way the
    // header just goes without a chip rather than failing to render.
    return []
  }
}

export function writeHistory(key: string, snapshots: BalanceSnapshot[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, JSON.stringify(snapshots))
  } catch {
    // Quota exceeded or storage blocked — the chip is not worth an exception.
  }
}
