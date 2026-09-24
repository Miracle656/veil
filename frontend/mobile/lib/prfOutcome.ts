/**
 * Why a passkey did or did not produce a PRF output.
 *
 * The PRF output is what lets a wallet be restored from the passkey alone, so a
 * missing one matters. Every failure used to collapse into `null`, which left
 * the create screen able to say only "couldn't bind the recovery secret" —
 * the same words for a password manager that will never support it, a prompt
 * the user closed, and a one-off error that a second tap would fix.
 */

import { errorMessage } from './errorMessage';
import { isUserRejection } from './walletConnectHelpers';

export type PrfOutcome =
  /** A usable PRF output. */
  | 'ok'
  /** The passkey answered, but without a PRF result: its manager does not implement PRF. */
  | 'unsupported'
  /** The prompt was closed or declined. */
  | 'cancelled'
  /** Anything else; worth trying again. */
  | 'failed';

export type PrfEvaluation = {
  output: Uint8Array | null;
  outcome: PrfOutcome;
  /** The underlying error text, for `failed` only. */
  detail?: string;
};

/** Classify a completed assertion (null when the platform returned nothing). */
export function prfFromAssertion(assertionReturned: boolean, output: Uint8Array | null): PrfEvaluation {
  if (!assertionReturned) return { output: null, outcome: 'cancelled' };
  if (output && output.length >= 32) return { output, outcome: 'ok' };
  return { output: null, outcome: 'unsupported' };
}

/** Classify a thrown assertion. */
export function prfFromError(error: unknown): PrfEvaluation {
  if (isUserRejection(error)) return { output: null, outcome: 'cancelled' };
  return { output: null, outcome: 'failed', detail: errorMessage(error) };
}
