import { Keypair } from '@stellar/stellar-sdk'
import { createHash } from 'crypto'

/**
 * The fixed message used by Stellar Private Payments (SPP) to derive privacy keys (V132).
 */
export const PRIVACY_KEY_DERIVATION_MESSAGE = 'Privacy Pool Key Derivation [v1]'

/**
 * Derives the deterministic SPP privacy public key from a Stellar signer secret (Ed25519).
 *
 * Signs the fixed SPP derivation message using the passkey/spending key, then hashes
 * the signature to produce the deterministic 32-byte hex privacy public key.
 */
export function derivePrivacyPublicKeyFromSecret(signerSecret: string): string {
  const kp = Keypair.fromSecret(signerSecret)
  return derivePrivacyPublicKeyFromKeypair(kp)
}

/**
 * Derives the deterministic SPP privacy public key from a Keypair.
 */
export function derivePrivacyPublicKeyFromKeypair(keypair: Keypair): string {
  const messageBytes = Buffer.from(PRIVACY_KEY_DERIVATION_MESSAGE, 'utf-8')
  const signature = keypair.sign(messageBytes)
  return createHash('sha256').update(signature).digest('hex')
}
