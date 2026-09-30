import { Keypair } from '@stellar/stellar-sdk'
import { createHash } from 'crypto'
import { getFeePayerMode, peekFeePayerKeypair, ensureFeePayer } from '@/lib/feePayer'

/**
 * The fixed SPP key-derivation message specified in SPP's protocol
 * (`sdk/native/src/zk/encryption.rs` and V132).
 */
export const SPP_KEY_DERIVATION_MESSAGE = 'Privacy Pool Key Derivation [v1]'

/**
 * Derived privacy key material for Stellar Private Payments.
 */
export interface PrivacyKeys {
  /** The 64-byte Ed25519 signature over the fixed key-derivation message. */
  signature: Buffer
  /** 32-byte note spending key (BN254 scalar seed). */
  noteSpendingKey: Buffer
  /** 32-byte public key registered in SPP's public_key_registry contract. */
  publicKeyBytes: Buffer
  /** Hex-encoded string of the registered public key. */
  publicKeyHex: string
}

/**
 * Derives SPP privacy keys from a valid PRF-derived signing Keypair.
 *
 * Ground rules:
 * 1. Derives by signing the canonical SPP message: "Privacy Pool Key Derivation [v1]".
 * 2. Refuses legacy (non-PRF) derivation: if the signer comes from a credential-ID
 *    fallback, it fails closed so privacy keys cannot be reconstructed from public data.
 * 3. Never logs or transmits the signature or private keys.
 */
export function derivePrivacyKeysFromSigner(signer: Keypair): PrivacyKeys {
  if (!signer || typeof signer.sign !== 'function') {
    throw new Error('Invalid signer keypair provided for privacy key derivation')
  }

  const messageBuffer = Buffer.from(SPP_KEY_DERIVATION_MESSAGE, 'utf8')
  const signature = signer.sign(messageBuffer)

  // SPP key derivation: derive BN254 / X25519 key material from the signature.
  // We use SHA-256 with domain separation to produce the 32-byte key representations.
  const noteSpendingKey = createHash('sha256')
    .update(signature)
    .update(Buffer.from('spp/note/spending-key/v1', 'utf8'))
    .digest()

  const publicKeyBytes = createHash('sha256')
    .update(signature)
    .update(Buffer.from('spp/public-key-registry/v1', 'utf8'))
    .digest()

  return {
    signature,
    noteSpendingKey,
    publicKeyBytes,
    publicKeyHex: publicKeyBytes.toString('hex'),
  }
}

/**
 * High-level helper to obtain privacy keys for the active wallet session.
 *
 * Enforces PRF-only derivation: throws if the active wallet is in 'legacy' mode.
 */
export async function getWalletPrivacyKeys(): Promise<PrivacyKeys> {
  const mode = getFeePayerMode()
  if (mode === 'legacy') {
    throw new Error(
      'Passkey does not support PRF key derivation; private keys cannot be securely derived from legacy credentials.'
    )
  }

  let kp = peekFeePayerKeypair()
  if (!kp) {
    kp = await ensureFeePayer()
  }

  if (!kp) {
    throw new Error('No active wallet session or signer found')
  }

  // Double-check mode after ensureFeePayer in case of cold session
  const finalMode = getFeePayerMode()
  if (finalMode === 'legacy') {
    throw new Error(
      'Passkey does not support PRF key derivation; private keys cannot be securely derived from legacy credentials.'
    )
  }

  return derivePrivacyKeysFromSigner(kp)
}
