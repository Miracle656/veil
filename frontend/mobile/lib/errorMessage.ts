/**
 * Turn an unknown thrown value into something worth showing a user.
 *
 * `String(e)` is the obvious thing to reach for and it is wrong for the values
 * this app actually catches. Native modules — `react-native-passkeys` above all
 * — reject with plain objects rather than `Error` instances, and `String({})`
 * is the literal text `[object Object]`. That is what a user saw after
 * cancelling the passkey prompt on the create-wallet screen.
 *
 * It is worse than an ugly string. `isUserRejection` compared against
 * `String(error)` too, so a cancellation arriving as an object stringified to
 * `[object Object]`, matched none of the cancellation markers, and was reported
 * as a failure instead of being handled as "the user changed their mind".
 *
 * So this walks the shapes that actually show up:
 *   - a string thrown directly
 *   - an `Error` with a message
 *   - `{ message }`, `{ error }`, `{ description }`, `{ reason }` — including
 *     when the value under that key is itself an error-like object
 *   - an HTTP client error, whose useful text is in the response body rather
 *     than in `.message`
 *   - anything else: JSON, so at least the fields are legible
 */

import { horizonErrorMessage } from './horizonError';

/** Keys that carry a human-readable message, most specific first. */
const MESSAGE_KEYS = ['message', 'error', 'description', 'reason', 'error_description'] as const;

/** Keys that carry a machine code, used only when no prose is available. */
const CODE_KEYS = ['code', 'name', 'status'] as const;

const FALLBACK = 'Something went wrong. Please try again.';

/**
 * The message an HTTP API put in its response body.
 *
 * Checked before an `Error`'s own `message`, because an axios rejection is an
 * `Error` whose message is only ever the status line — "Request failed with
 * status code 400". The reason for the 400 is in `response.data`, and dropping
 * it is the difference between an error a user can act on ("Missing trustline
 * in G… for asset: USDC") and one nobody can diagnose.
 */
function httpBodyMessage(error: unknown, depth: number): string | null {
  if (!error || typeof error !== 'object' || depth >= 3) return null;

  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return null;

  const data = (response as { data?: unknown }).data;
  if (typeof data === 'string' && data.trim() !== '') return data.trim();

  if (data && typeof data === 'object') {
    // Horizon first: its prose is a paragraph pointing at documentation, while
    // the reason is a short code elsewhere in the document.
    const horizon = horizonErrorMessage(data);
    if (horizon) return horizon;

    const message = errorMessage(data, depth + 1);
    if (message !== FALLBACK) return message;
  }

  return null;
}

function firstString(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/**
 * A displayable message for any thrown value.
 *
 * @param depth Guards against a cyclic or deeply nested error chain.
 */
export function errorMessage(error: unknown, depth = 0): string {
  if (typeof error === 'string' && error.trim() !== '') return error.trim();

  // Before the Error's own message: an HTTP body says why, a status line does not.
  const fromBody = httpBodyMessage(error, depth);
  if (fromBody) return fromBody;

  if (error instanceof Error && error.message) return error.message;

  if (error && typeof error === 'object' && depth < 3) {
    const source = error as Record<string, unknown>;

    // The stellar-sdk rejects with the failure document itself in some paths.
    const horizon = horizonErrorMessage(source);
    if (horizon) return horizon;

    const prose = firstString(source, MESSAGE_KEYS);
    if (prose) return prose;

    // `{ error: { message } }` and similar nestings.
    for (const key of MESSAGE_KEYS) {
      const nested = source[key];
      if (nested && typeof nested === 'object') {
        const message = errorMessage(nested, depth + 1);
        if (message !== FALLBACK) return message;
      }
    }

    const code = firstString(source, CODE_KEYS);
    if (code) return code;

    // Last resort before the generic text: show the actual fields rather than
    // "[object Object]", which tells the user and us precisely nothing.
    try {
      const json = JSON.stringify(error);
      if (json && json !== '{}' && json !== 'null') return json;
    } catch {
      // Cyclic structure — fall through.
    }
  }

  if (typeof error === 'number' || typeof error === 'boolean') return String(error);

  return FALLBACK;
}
