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
 *   - anything else: JSON, so at least the fields are legible
 */

/** Keys that carry a human-readable message, most specific first. */
const MESSAGE_KEYS = ['message', 'error', 'description', 'reason', 'error_description'] as const;

/** Keys that carry a machine code, used only when no prose is available. */
const CODE_KEYS = ['code', 'name', 'status'] as const;

const FALLBACK = 'Something went wrong. Please try again.';

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

  if (error instanceof Error && error.message) return error.message;

  if (error && typeof error === 'object' && depth < 3) {
    const source = error as Record<string, unknown>;

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
