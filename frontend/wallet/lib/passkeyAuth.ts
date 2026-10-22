import { walletLocal } from '@/lib/walletStorage'
import {
  PASSKEY_CANCELLED_MESSAGE,
  PASSKEY_REFUSED_MESSAGE,
  PasskeyCeremonyError,
  classifyPasskeyError,
  passkeyFailureMessage,
  passkeyRawMessage,
  toPasskeyCeremonyError,
} from '@/lib/passkeyOutcome'

/**
 * Prompt the user's registered passkey (Face ID / fingerprint / PIN) to
 * authorise a sensitive action.
 *
 * Throws a {@link PasskeyCeremonyError} that says which of three things
 * happened: the user cancelled, the authenticator refused, or the ceremony
 * genuinely failed. A cancellation is not an error state on a spend screen.
 */
export async function requirePasskey(): Promise<void> {
  const keyId = walletLocal.getItem('invisible_wallet_key_id')
  if (!keyId) {
    throw new PasskeyCeremonyError(
      'refused',
      'No passkey found. Register the wallet first, then try again.',
    )
  }

  const normalized = keyId.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const credIdBin = atob(padded)
  const credId    = Uint8Array.from(credIdBin, c => c.charCodeAt(0))
  const challenge = crypto.getRandomValues(new Uint8Array(32))

  let assertion: Credential | null
  try {
    assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ id: credId, type: 'public-key' }],
        userVerification: 'required',
        timeout: 60_000,
      },
    })
  } catch (error: unknown) {
    // NotAllowedError / AbortError are dismissals and timeouts; SecurityError,
    // NotSupportedError and InvalidStateError are refusals with a next step.
    throw toPasskeyCeremonyError(error)
  }

  if (!assertion) {
    throw new PasskeyCeremonyError('cancelled', PASSKEY_CANCELLED_MESSAGE)
  }
}

/**
 * Map WebAuthn / DOMExceptions to a line a person can act on. Never leak spec
 * URLs. Cancellation gets the calm sentence (screens still check the outcome
 * and avoid the error state); a refusal gets the step that might fix it.
 */
export function passkeyErrorMessage(err: unknown): string {
  if (err instanceof PasskeyCeremonyError) return err.message

  const outcome = classifyPasskeyError(err)
  if (outcome === 'cancelled') return PASSKEY_CANCELLED_MESSAGE
  if (outcome === 'refused') return passkeyFailureMessage(err) ?? PASSKEY_REFUSED_MESSAGE

  const raw = passkeyRawMessage(err)
  return raw || 'Something went wrong. Please try again.'
}
