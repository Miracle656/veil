/**
 * The backstop's amount and date arithmetic, tested where it lives.
 *
 * `lib/backstopAmounts.ts` imports nothing — no Stellar SDK, no Blend SDK — so
 * these are the shipping functions, not a copy kept in step by hand. The tests
 * used to sit in `backstop.test.ts`, whose SDK mocks meant the helpers were
 * never the thing under test there.
 */
import {
  FALLBACK_QUEUE_LOCK_SECONDS,
  STROOPS_PER_SHARE,
  formatLockDuration,
  formatUnlockDate,
  sharesToStroops,
  stroopsToShares,
} from '../backstopAmounts'

describe('STROOPS_PER_SHARE', () => {
  it('is the 7-decimal scale every Stellar amount uses', () => {
    expect(STROOPS_PER_SHARE).toBe(10_000_000n)
  })
})

describe('share amounts', () => {
  it('converts every supported decimal shape to stroops', () => {
    expect(sharesToStroops('1')).toBe(10_000_000n)
    expect(sharesToStroops('0.0000001')).toBe(1n)
    expect(sharesToStroops('1234.5')).toBe(12_345_000_000n)
  })

  it('refuses zero, negatives, and precision the contract cannot represent', () => {
    expect(() => sharesToStroops('0')).toThrow('greater than zero')
    expect(() => sharesToStroops('-1')).toThrow()
    expect(() => sharesToStroops('1.00000001')).toThrow()
    expect(() => sharesToStroops('abc')).toThrow()
  })

  it('round-trips without losing a stroop', () => {
    for (const value of ['1', '0.5', '1042.0000001']) {
      expect(stroopsToShares(sharesToStroops(value))).toBe(value)
    }
    expect(stroopsToShares(0n)).toBe('0')
  })
})

describe('formatLockDuration', () => {
  it('reads a lock as days, not a hardcoded label', () => {
    expect(formatLockDuration(17 * 24 * 60 * 60)).toBe('17 days')
    expect(formatLockDuration(24 * 60 * 60)).toBe('1 day')
    expect(formatLockDuration(2 * 24 * 60 * 60 + 4 * 60 * 60)).toBe('2 days 4 hours')
    expect(formatLockDuration(45 * 60)).toBe('45 minutes')
  })

  it('is the documented fallback only when nothing was read', () => {
    expect(formatLockDuration(FALLBACK_QUEUE_LOCK_SECONDS)).toBe('17 days')
  })
})

describe('formatUnlockDate', () => {
  it('renders the contract timestamp in UTC, so two devices agree', () => {
    // 2026-01-15T09:05:00Z. A reader in UTC-5 sees 04:05 that morning; the
    // label must show the UTC instant the contract stamped, not local time.
    const unlockAt = Math.floor(Date.UTC(2026, 0, 15, 9, 5) / 1000)
    expect(formatUnlockDate(unlockAt)).toBe('Jan 15, 2026, 09:05 AM UTC')
  })

  it('keeps the UTC date across a local midnight', () => {
    // 2025-12-31T23:59Z is already Jan 1 in UTC+1. The date shown is the UTC
    // one, so a queue that unlocks "tomorrow" in UTC is not dated by the
    // browser's zone.
    const unlockAt = Math.floor(Date.UTC(2025, 11, 31, 23, 59) / 1000)
    expect(formatUnlockDate(unlockAt)).toBe('Dec 31, 2025, 11:59 PM UTC')
  })
})
