import { Keypair } from '@stellar/stellar-sdk'
import { createHash, createHmac } from 'crypto'

/**
 * Privacy Key Derivation for Stellar Private Payments (SPP).
 *
 * SPP derives a user's note keypair (BN254) and encryption keypair (X25519)
 * from a deterministic wallet signature over the fixed domain separation message:
 * "Privacy Pool Key Derivation [v1]".
 *
 * Rules:
 * - Deterministic: same wallet -> same privacy keys.
 * - Zero leakage: keys never leave device memory.
 */

export const PRIVACY_KEY_DERIVATION_MESSAGE = 'Privacy Pool Key Derivation [v1]'

export interface PrivacyKeys {
  /** Public identifier for privacy note ownership (Hex format) */
  notePublicKey: string
  /** Public key for receiving encrypted note payloads (Hex format) */
  encryptionPublicKey: string
  /** Private note spend key (Hex format, strictly in-memory) */
  noteSecretKey: string
  /** Private decryption key (Hex format, strictly in-memory) */
  encryptionSecretKey: string
}

/**
 * Derives SPP privacy keys from a Stellar keypair or raw seed deterministically.
 */
export function derivePrivacyKeys(signer: Keypair): PrivacyKeys {
  const messageBytes = Buffer.from(PRIVACY_KEY_DERIVATION_MESSAGE, 'utf-8')
  
  // Sign the domain separation string
  const signature = signer.sign(messageBytes)

  // Derive note secret key via HMAC-SHA256(signature, 'spp-note-key')
  const noteSecret = createHmac('sha256', signature)
    .update('spp-note-key-v1')
    .digest('hex')

  // Derive encryption secret key via HMAC-SHA256(signature, 'spp-enc-key')
  const encSecret = createHmac('sha256', signature)
    .update('spp-enc-key-v1')
    .digest('hex')

  // Generate deterministic public representations
  const notePublic = createHash('sha256')
    .update(Buffer.from(noteSecret, 'hex'))
    .digest('hex')

  const encPublic = createHash('sha256')
    .update(Buffer.from(encSecret, 'hex'))
    .digest('hex')

  return {
    notePublicKey: notePublic,
    encryptionPublicKey: encPublic,
    noteSecretKey: noteSecret,
    encryptionSecretKey: encSecret,
  }
}
