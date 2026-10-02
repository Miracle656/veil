import {
  change24h,
  historyKey,
  isComparableTotal,
  pruneSnapshots,
  recordSnapshot,
  type BalanceSnapshot,
} from '../balanceHistory'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = 1_800_000_000_000

const at = (msAgo: number, usd: number): BalanceSnapshot => ({ t: NOW - msAgo, usd })

describe('historyKey', () => {
  // A testnet total read back as a mainnet one would show an invented change.
  it('scopes the entry by network and address', () => {
    expect(historyKey('testnet', 'CABC')).not.toBe(historyKey('mainnet', 'CABC'))
    expect(historyKey('mainnet', 'CABC')).not.toBe(historyKey('mainnet', 'CDEF'))
  })
})

describe('pruneSnapshots', () => {
  it('drops entries older than the retention window and sorts oldest first', () => {
    const kept = pruneSnapshots([at(2 * DAY, 20), at(8 * DAY, 10), at(HOUR, 30)], NOW)
    expect(kept.map((s) => s.usd)).toEqual([20, 30])
  })

  it('drops malformed entries rather than trusting stored JSON', () => {
    const junk = [{ t: 'yesterday', usd: 5 }, { usd: 5 }, null, at(HOUR, 30)] as BalanceSnapshot[]
    expect(pruneSnapshots(junk, NOW)).toEqual([at(HOUR, 30)])
  })

  // A clock that jumped backwards would otherwise leave an entry that never
  // ages out of the 24h window.
  it('drops future-dated entries', () => {
    expect(pruneSnapshots([at(-HOUR, 99)], NOW)).toEqual([])
  })
})

describe('recordSnapshot', () => {
  it('appends when the newest entry has aged past the interval', () => {
    const next = recordSnapshot([at(2 * HOUR, 100)], 120, NOW)
    expect(next).toHaveLength(2)
    expect(next[1]).toEqual({ t: NOW, usd: 120 })
  })

  // The dashboard re-runs this on every balance refresh; without the guard a
  // busy session would fill the entry with near-identical points.
  it('does not append while the newest entry is still fresh', () => {
    expect(recordSnapshot([at(10 * 60 * 1000, 100)], 120, NOW)).toEqual([at(10 * 60 * 1000, 100)])
  })

  it('records the first snapshot on an empty history', () => {
    expect(recordSnapshot([], 100, NOW)).toEqual([{ t: NOW, usd: 100 }])
  })

  it('refuses to store a non-finite total', () => {
    expect(recordSnapshot([], NaN, NOW)).toEqual([])
  })
})

describe('change24h', () => {
  it('measures against the newest snapshot that is already a full day old', () => {
    // 25h is eligible, 30h is older, 2h is not eligible at all. Measuring
    // against the 2h point would report a fraction of the day's move.
    const history = [at(30 * HOUR, 50), at(25 * HOUR, 100), at(2 * HOUR, 110)]
    expect(change24h(history, 120, NOW)).toBeCloseTo(20, 10)
  })

  it('reports a loss as negative', () => {
    expect(change24h([at(25 * HOUR, 200)], 150, NOW)).toBeCloseTo(-25, 10)
  })

  // The chip has to hide rather than show 0% on a wallet opened this morning.
  it('returns null when no snapshot is a full day old yet', () => {
    expect(change24h([at(2 * HOUR, 100)], 120, NOW)).toBeNull()
  })

  it('returns null on an empty history', () => {
    expect(change24h([], 120, NOW)).toBeNull()
  })

  it('returns null rather than dividing by a zero baseline', () => {
    expect(change24h([at(25 * HOUR, 0)], 120, NOW)).toBeNull()
  })

  // Prices are unavailable often enough that this is the ordinary path, not an
  // edge case: Lens is down and every non-USDC price comes back null.
  it('returns null when the current total is not a number', () => {
    expect(change24h([at(25 * HOUR, 100)], NaN, NOW)).toBeNull()
  })
})

describe('isComparableTotal', () => {
  it('accepts a total in which every asset was priced', () => {
    expect(isComparableTotal(2, 2)).toBe(true)
  })

  // The case that matters: Lens is returning 503, so XLM has no price while
  // USDC is hardcoded to 1.0. The total then covers the USDC alone, and
  // comparing it with yesterday's full total reported the outage as a ~48%
  // loss on a wallet that had not moved.
  it('rejects a total assembled from only some of the assets', () => {
    expect(isComparableTotal(2, 1)).toBe(false)
  })

  it('rejects an empty wallet, which has nothing to compare', () => {
    expect(isComparableTotal(0, 0)).toBe(false)
  })
})
