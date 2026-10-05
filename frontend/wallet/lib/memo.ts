/**
 * Stellar memo validation utilities (V206 — Issue #818).
 *
 * `Memo.text()` on Stellar is capped at exactly 28 bytes UTF-8 (not UTF-16 code units / characters).
 * Multi-byte Unicode characters (e.g. accented letters, Cyrillic, CJK, emojis) consume 2-4 bytes each.
 *
 * This 28-byte cap applies to text memos only — a MEMO_HASH is 64 hex characters and isn't
 * covered here. CSV-driven flows (e.g. bulk payout) can't currently express a memo type per
 * row, so treating every memo as text is correct for them today.
 */

export const MAX_MEMO_TEXT_BYTES = 28
export const MEMO_EXCEEDS_LIMIT_MESSAGE = 'Memo exceeds the 28-byte limit'

/**
 * Returns the UTF-8 byte length of a string.
 */
export function getMemoByteLength(memo: string): number {
  return new TextEncoder().encode(memo).length
}

/**
 * Validates a text memo string against the 28-byte Stellar protocol limit.
 * Returns null if valid, or a descriptive error message naming the limit if exceeded.
 */
export function validateMemoText(memo?: string | null): string | null {
  if (!memo) return null
  if (getMemoByteLength(memo) > MAX_MEMO_TEXT_BYTES) {
    return MEMO_EXCEEDS_LIMIT_MESSAGE
  }
  return null
}
