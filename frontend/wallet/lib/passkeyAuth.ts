import { walletLocal } from '@/lib/walletStorage'

/**
 * Prompt the user's registered passkey (Face ID / fingerprint / PIN) to
 * authorise a sensitive action. Throws if verification fails or is cancelled.
 */
export async function requirePasskey(): Promise<void> {
  const keyId = walletLocal.getItem('invisible_wallet_key_id')
  if (!keyId) throw new Error('No passkey found. Please register the wallet first.')

  const normalized = keyId.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const credIdBin = atob(padded)
  const credId    = Uint8Array.from(credIdBin, c => c.charCodeAt(0))
  const challenge = crypto.getRandomValues(new Uint8Array(32))

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ id: credId, type: 'public-key' }],
      userVerification: 'required',
      timeout: 60_000,
    },
  })

  if (!assertion) throw new Error('Passkey verification was cancelled.')
}

/** Map WebAuthn / DOMExceptions to a line a person can act on. Never leak spec URLs. */
export function passkeyErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : ''
  const raw = err instanceof Error ? err.message : String(err ?? '')
  const blob = `${name} ${raw}`.toLowerCase()

  if (
    name === 'NotAllowedError'
    || name === 'AbortError'
    || blob.includes('not allowed')
    || blob.includes('timed out')
    || blob.includes('privacy-considerations-client')
  ) {
    return "The passkey was cancelled, timed out, or isn't on this device. Try again."
  }

  if (name === 'NotSupportedError' || blob.includes('not supported')) {
    return "This browser doesn't support passkeys."
  }

  if (name === 'SecurityError') {
    return 'Passkeys need a secure page (HTTPS). Open Veil from the app link and try again.'
  }

  const cleaned = raw.replace(/https?:\/\/\S+/g, '').replace(/\s*see:\s*$/i, '').trim()
  return cleaned || 'Something went wrong. Please try again.'
}
