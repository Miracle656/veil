/**
 * Stellar's classic text memo (`Memo.text`) holds at most 28 BYTES, not 28
 * characters: "é" is 2 bytes and most emoji are 4, so a memo that looks short can
 * still be over the limit. `Memo.text()` throws above it.
 *
 * A memo often arrives from a deep link or a QR code, so it is untrusted input.
 * Validate it with `memoError` BEFORE building or signing anything, and show the
 * message as a validation error - never let the `Memo.text()` throw reach a
 * handler that reports it as something else (e.g. a passkey failure).
 *
 * Web (`frontend/wallet/lib/memo.ts`) and mobile (`frontend/mobile/lib/memo.ts`)
 * keep identical copies of this module, tests included, so the limit and the
 * message agree.
 */

/** Maximum size of a classic text memo, in bytes. */
export const MEMO_MAX_BYTES = 28;

/** UTF-8 size of `memo` in bytes (what the network counts). */
export function memoByteLength(memo: string): number {
  return new TextEncoder().encode(memo).length;
}

/** A user-facing message when `memo` is too long, otherwise null. Blank memos are fine. */
export function memoError(memo: string | null | undefined): string | null {
  const text = memo?.trim();
  if (!text) return null;
  const bytes = memoByteLength(text);
  if (bytes <= MEMO_MAX_BYTES) return null;
  return `Memo is too long: ${bytes} bytes (the limit is ${MEMO_MAX_BYTES} bytes; some characters use more than one).`;
}
