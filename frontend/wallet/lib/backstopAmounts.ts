/**
 * Backstop amounts and dates, in one place and with no SDK imports.
 *
 * These are the conversions and labels the backstop screen renders: LP/share
 * amounts, the queue lock duration and an absolute unlock time. They live in
 * their own module for two reasons:
 *
 *   1. `lib/backstop.ts` imports the Blend SDK, whose pinned
 *      `@stellar/stellar-sdk` 16 pulls ESM-only `@noble/*` that the wallet's
 *      Jest runtime cannot load. Anything the screen needs to *format* a
 *      number must therefore live outside it, or the screen's test has to
 *      re-implement the arithmetic to avoid the import — and a copy of the
 *      arithmetic is not the code that ships.
 *   2. There is one implementation of each rule. The page, that page's test
 *      and the ledger-reading module all import these, so a rounding or
 *      plurality change cannot land in one of them and not the others.
 */

/** LP shares carry the same 7 decimals as every other Stellar amount. */
export const STROOPS_PER_SHARE = 10_000_000n

/**
 * Blend's `Q4W_LOCK_TIME` — the queue lock — in seconds, used only until the
 * deployed contract has been asked. The value is the constant in
 * `blend-contracts-v2/backstop/src/constants.rs`; the contract exposes no
 * getter for it, so it is read out of a simulated `queue_withdrawal` (see
 * `loadBackstopQueueLockSeconds`) and this is the documented fallback when that
 * read cannot be made.
 */
export const FALLBACK_QUEUE_LOCK_SECONDS = 17 * 24 * 60 * 60

/** A typed decimal amount as the 7-decimal integer the contract takes. */
export function sharesToStroops(value: string): bigint {
  const amount = value.trim()
  if (!/^\d+(?:\.\d{0,7})?$/.test(amount)) {
    throw new Error('Enter a valid amount with no more than 7 decimal places.')
  }
  const [whole, fraction = ''] = amount.split('.')
  const stroops = BigInt(whole) * STROOPS_PER_SHARE + BigInt(fraction.padEnd(7, '0'))
  if (stroops <= 0n) {
    throw new Error('Amount must be greater than zero.')
  }
  return stroops
}

/** The inverse, with trailing zeros trimmed so `4.0000000` reads as `4`. */
export function stroopsToShares(stroops: bigint): string {
  const negative = stroops < 0n
  const absolute = negative ? -stroops : stroops
  const whole = absolute / STROOPS_PER_SHARE
  const fraction = (absolute % STROOPS_PER_SHARE)
    .toString()
    .padStart(7, '0')
    .replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

/**
 * A duration in seconds as the words the screen uses: "17 days", "2 days
 * 4 hours", "45 minutes". Rounded at the minute, because the contract's lock is
 * read from a simulated queue entry and is only as exact as the close time.
 */
export function formatLockDuration(seconds: number): string {
  const totalMinutes = Math.max(0, Math.round(seconds / 60))
  const days = Math.floor(totalMinutes / 1_440)
  const hours = Math.floor((totalMinutes % 1_440) / 60)
  const minutes = totalMinutes % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days} ${days === 1 ? 'day' : 'days'}`)
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`)
  if (days === 0 && minutes > 0) {
    parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`)
  }
  return parts.length > 0 ? parts.join(' ') : '0 minutes'
}

/** An absolute unlock time, in UTC, so two devices agree on the date. */
export function formatUnlockDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1_000).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  })
}
