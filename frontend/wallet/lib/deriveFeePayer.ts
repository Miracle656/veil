import { Keypair } from '@stellar/stellar-sdk'

/**
 * Deterministically derive a fee-payer Ed25519 keypair from a WebAuthn credential ID.
 *
 * The passkey credential ID is device-bound but recoverable via biometrics —
 * given the same credential, this always produces the same keypair. This means
 * clearing localStorage or moving to a new browser session doesn't lose access
 * to the fee-payer account: re-authenticating with the passkey gives back the
 * same credential ID, which derives the same keypair.
 *
 * The derivation uses HKDF (RFC 5869) with SHA-256:
 *   - IKM  = raw credential ID bytes
 *   - salt = fixed domain string to prevent cross-app collisions
 *   - info = version tag so we can rotate the scheme if needed
 *
 * The 32-byte HKDF output is used as an Ed25519 seed.
 */

const SALT = new TextEncoder().encode('veil:feepayer:salt:v1')
const INFO = new TextEncoder().encode('veil:feepayer:ed25519:v1')

function base64UrlToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const rawId = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) rawId[i] = binary.charCodeAt(i)
  return rawId
}

/**
 * Derive a Stellar Keypair from a base64url-encoded WebAuthn credential ID.
 */
export async function deriveFeePayerKeypair(credentialIdBase64url: string): Promise<Keypair> {
  // Decode base64url → raw bytes
  const rawId = base64UrlToUint8Array(credentialIdBase64url)

  // HKDF: extract then expand
  const keyMaterial = await crypto.subtle.importKey(
    'raw', rawId, 'HKDF', false, ['deriveBits']
  )

  const derived = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: INFO },
    keyMaterial,
    256 // 32 bytes = Ed25519 seed
  )

  return Keypair.fromRawEd25519Seed(Buffer.from(derived))
}

/**
 * Convenience: derive the fee-payer from the credential ID stored in localStorage.
 * Returns null if no credential ID is stored.
 */
export async function deriveStoredFeePayer(): Promise<Keypair | null> {
  const keyId = localStorage.getItem('invisible_wallet_key_id')
  if (!keyId) return null
  return deriveFeePayerKeypair(keyId)
}
