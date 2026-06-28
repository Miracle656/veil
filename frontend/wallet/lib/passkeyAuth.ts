/**
 * Prompt the user's registered passkey (Face ID / fingerprint / PIN) to
 * authorise a sensitive action. Throws if verification fails or is cancelled.
 */
export async function requirePasskey(): Promise<void> {
  const keyId = localStorage.getItem('invisible_wallet_key_id')
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
