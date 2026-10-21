/**
 * The three things a passkey prompt can do, and the words for each.
 *
 * They are genuinely different events:
 *
 *   - **cancelled** — the user dismissed the sheet or it timed out. That is a
 *     decision, not a fault. Nothing was sent, nothing should turn red, and the
 *     screen should be exactly where they left it.
 *   - **refused** — the device's authenticator could not complete the ceremony:
 *     no matching credential, an unsupported passkey manager, or a relying
 *     party that does not match the wallet's. The next step is specific, so say
 *     it instead of "something went wrong".
 *   - **failed** — anything else. Worth another try, with the real reason when
 *     there is one.
 *
 * Every spend path used to collapse all three into one caught error and one
 * "Passkey cancelled. Please try again." banner. That teaches people the app is
 * broken when they simply changed their mind, and hides what to do when their
 * authenticator is the obstacle.
 */

import { errorMessage } from './errorMessage';

export type PasskeyOutcome =
  /** The prompt was dismissed (or timed out) — the user changed their mind. */
  | 'cancelled'
  /** The authenticator could not complete the ceremony; the copy says what to try. */
  | 'refused'
  /** A genuine failure. Nothing was sent; trying again may work. */
  | 'failed';

export const PASSKEY_CANCELLED_MESSAGE = 'Passkey cancelled. Nothing was sent.';

export const PASSKEY_REFUSED_MESSAGE =
  "Your device's authenticator refused the passkey check. Make sure a passkey for this wallet is set up on this device, then try again.";

export const PASSKEY_UNSUPPORTED_MESSAGE =
  "This device or passkey manager does not support the passkey check Veil needs. Try a different device, or use a passkey manager that supports it, then try again.";

export const PASSKEY_SECURITY_MESSAGE =
  "The passkey can't be used here. Open Veil from the same address you created the wallet with, then try again.";

export const PASSKEY_NO_CREDENTIAL_MESSAGE =
  'No passkey for this wallet is available on this device. Add the passkey in Settings → Security, or use a device that has it, then try again.';

/**
 * The one credential that is genuinely unusable on this device: a passkey bound
 * to an older relying party. The id and public key are still in secure storage,
 * but no authenticator here can answer for them.
 */
export const CREDENTIAL_ORPHANED_MESSAGE =
  'This wallet’s passkey was created against an earlier Veil domain, so this device can no longer use it. ' +
  'Create a new wallet on this network — your wallets on other networks are unaffected.';

/**
 * A ceremony error that carries its outcome, so a screen never has to parse
 * prose to decide whether to show an error at all.
 */
export class PasskeyCeremonyError extends Error {
  readonly outcome: PasskeyOutcome;

  constructor(outcome: PasskeyOutcome, message: string) {
    super(message);
    this.name = 'PasskeyCeremonyError';
    this.outcome = outcome;
  }
}

/**
 * Markers for "the authenticator could not answer", as opposed to the user
 * closing the sheet or a network/module failure. Matched against the lowercased
 * display message so plain-object rejections from native modules work too.
 */
const REFUSAL_MARKERS = [
  'notsupportederror',
  'not supported',
  'does not support',
  'no support',
  'unsupported',
  'securityerror',
  'secure page',
  'relying party',
  'rp id',
  'different domain',
  'earlier veil domain',
  'invalidstateerror',
  'constrainterror',
  'no passkey',
  'no credentials',
  'no matching credential',
  'nomatchingcredential',
] as const;

/**
 * The DOMException names WebAuthn uses when the user closes the sheet or lets
 * it expire. They are the ONLY thing that makes a timeout a cancellation: the
 * ceremony itself says so by name, not by wording.
 */
const CANCELLATION_ERROR_NAMES = ['notallowederror', 'aborterror'] as const;

/**
 * Words only a person's own decision produces. Deliberately excludes bare
 * "cancel", "timeout", "timed out" and "dismiss": an aborted request or a
 * Horizon timeout carries those too ("timeout of 30000ms exceeded"), and a
 * failed submission read as a cancellation returns the user to the form with
 * nothing said — possibly after the transaction already reached the network.
 */
const USER_DECISION_MARKERS = [
  'user_rejected',
  'user rejected',
  'usercancelled',
  'usercanceled',
  'user_cancelled',
  'user_canceled',
  'user cancelled',
  'user canceled',
  'cancelled by the user',
  'canceled by the user',
] as const;

/** The DOMException name a thrown value carries, including native object rejections. */
function ceremonyErrorName(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && name.trim() !== '') return name.trim();
    // react-native-passkeys rejects with `{ error: 'NotAllowedError' }`.
    const field = (error as { error?: unknown }).error;
    if (typeof field === 'string' && field.trim() !== '') return field.trim();
  }
  return '';
}

/**
 * Whether a thrown value is the user's own decision to cancel the passkey
 * ceremony — a dismissal, a closed sheet, or the ceremony's own timeout.
 *
 * Only two things count: a `PasskeyCeremonyError` whose outcome is
 * `cancelled`, or a DOMException named `NotAllowedError` / `AbortError`. A
 * plain error whose text merely mentions a timeout is a failure, because a
 * network or RPC timeout during submission is exactly that.
 */
export function isPasskeyCancellation(error: unknown): boolean {
  if (error instanceof PasskeyCeremonyError) return error.outcome === 'cancelled';

  const name = ceremonyErrorName(error).toLowerCase();
  if (CANCELLATION_ERROR_NAMES.some((candidate) => name === candidate)) return true;

  // Native modules prefix the DOMException name to their message:
  // "NotAllowedError: the request was denied".
  const text = errorMessage(error).trim().toLowerCase();
  if (CANCELLATION_ERROR_NAMES.some((candidate) => text === candidate || text.startsWith(`${candidate}:`))) {
    return true;
  }

  return USER_DECISION_MARKERS.some((marker) => text.includes(marker));
}

/** The outcome of a thrown ceremony error, without changing its message. */
export function classifyPasskeyError(error: unknown): PasskeyOutcome {
  if (error instanceof PasskeyCeremonyError) return error.outcome;
  if (isPasskeyCancellation(error)) return 'cancelled';

  const blob = errorMessage(error).toLowerCase();
  if (REFUSAL_MARKERS.some((marker) => blob.includes(marker))) return 'refused';
  return 'failed';
}

function refusalMessage(error: unknown): string {
  const blob = errorMessage(error).toLowerCase();
  if (blob.includes('earlier veil domain') || blob.includes('no credentials') || blob.includes('no matching credential') || blob.includes('nomatchingcredential')) {
    return CREDENTIAL_ORPHANED_MESSAGE;
  }
  if (blob.includes('not supported') || blob.includes('does not support') || blob.includes('notsupportederror') || blob.includes('unsupported') || blob.includes('no support')) {
    return PASSKEY_UNSUPPORTED_MESSAGE;
  }
  if (blob.includes('securityerror') || blob.includes('secure page') || blob.includes('relying party') || blob.includes('rp id') || blob.includes('different domain')) {
    return PASSKEY_SECURITY_MESSAGE;
  }
  if (blob.includes('no passkey') || blob.includes('not found') || blob.includes('invalidstateerror')) {
    return PASSKEY_NO_CREDENTIAL_MESSAGE;
  }
  return PASSKEY_REFUSED_MESSAGE;
}

/**
 * A ceremony error with the outcome attached and copy a person can act on.
 * Cancellation keeps a calm sentence rather than an alarming one — screens
 * still check {@link isPasskeyCancellation} and avoid the error state entirely.
 */
export function toPasskeyCeremonyError(error: unknown): PasskeyCeremonyError {
  if (error instanceof PasskeyCeremonyError) return error;

  const outcome = classifyPasskeyError(error);
  if (outcome === 'cancelled') {
    return new PasskeyCeremonyError('cancelled', PASSKEY_CANCELLED_MESSAGE);
  }
  if (outcome === 'refused') {
    return new PasskeyCeremonyError('refused', refusalMessage(error));
  }

  const detail = errorMessage(error);
  const message =
    detail === 'Something went wrong. Please try again.'
      ? 'The passkey check failed. Nothing was sent — please try again.'
      : `${detail} Nothing was sent. Please try again.`;
  return new PasskeyCeremonyError('failed', message);
}

/**
 * What a screen should show for a ceremony that did not succeed. Cancellation
 * returns null: there is no error state to set, only the place the user was.
 */
export function passkeyFailureMessage(error: unknown): string | null {
  const outcome = classifyPasskeyError(error);
  if (outcome === 'cancelled') return null;
  if (error instanceof PasskeyCeremonyError) return error.message;
  return toPasskeyCeremonyError(error).message;
}
