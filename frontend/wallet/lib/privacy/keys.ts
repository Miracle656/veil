/**
 * Privacy key derivation from the passkey wallet (#711).
 *
 * SPP (NethermindEth/stellar-private-payments) derives a wallet's note keypair
 * (BN254) and encryption keypair (X25519) from one Ed25519 signature: the
 * owner's spend key signing the fixed message `KEY_DERIVATION_MESSAGE` under
 * the SEP-53 framing, exactly as
 * `sdk/native/src/zk/encryption.rs` does upstream:
 *
 *   digest    = SHA-256("Stellar Signed Message:\n" || message)
 *   signature = Ed25519 sign(digest)          — raw 64 bytes
 *   note key  = BN254 Fr(SHA-256(NOTE_KEY_DOMAIN      || signature))
 *   enc  key  = X25519(SHA-256(ENCRYPTION_KEY_DOMAIN || signature))
 *
 * Veil's spend key is the fee-payer keypair, which for any wallet created or
 * recovered through a passkey is derived from the WebAuthn PRF output under
 * `FEE_PAYER_PRF_SALT` — so the same passkey yields the same privacy keys on
 * every device (the golden vector in `__tests__/keys.test.ts` is shared with
 * `frontend/mobile/lib/privacy/keys.ts`). This module produces the signature
 * and SPP's exact key seeds; materialising the BN254 / X25519 keys from those
 * seeds is the SPP client's job (V134/V141).
 *
 * SECURITY (docs/PRIVACY_THREAT_MODEL.md §4, V132): this refuses to sign with
 * a `legacy` fee payer. The legacy seed is HKDF over the credential ID, which
 * is not a secret — anyone who can read the credential ID could reconstruct
 * the key, forge note spends, and would silently NOT match the same passkey's
 * keys on other devices. A legacy wallet must be re-established with a
 * PRF-capable passkey before it can shield anything.
 *
 * Nothing here is persisted: the signature lives only in the returned object
 * for the duration of the derivation call, and neither key, note nor signature
 * is ever logged or sent anywhere.
 */

import { Keypair, hash } from '@stellar/stellar-sdk'
import { evaluateFeePayerPrf, type PrfEvaluator } from '@veil/prf'

import { getFeePayerMode, peekFeePayerKeypair } from '../feePayer'
import { walletLocal } from '@/lib/walletStorage'

/** The message SPP signs to derive privacy keys. Must match upstream byte-for-byte. */
export const KEY_DERIVATION_MESSAGE = 'Privacy Pool Key Derivation [v1]'

/** SEP-53 framing, as in upstream `encryption.rs` (`SEP53_MESSAGE_PREFIX`). */
export const SEP53_MESSAGE_PREFIX = 'Stellar Signed Message:\n'

/** Domain separators for each derived key, as in upstream `encryption.rs`. */
export const NOTE_KEY_DOMAIN = 'privacy-pool/note-key/v1'
export const ENCRYPTION_KEY_DOMAIN = 'privacy-pool/encryption-key/v1'
export const MEMBERSHIP_BLINDING_DOMAIN = 'privacy-pool/asp-secret/v1'

/** Upstream rejects any key-derivation signature that is not exactly this long. */
const ED25519_SIGNATURE_LENGTH = 64

/** Mirrors `lib/privacy.ts` in the mobile app — a refusal the screens can surface verbatim. */
export class PrivacyKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PrivacyKeyError'
  }
}

function utf8(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'utf8'))
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function sha256(data: Uint8Array): Buffer {
  // stellar-base types `hash` as Buffer in/out; wrapping the bytes is a view,
  // not a copy, so the digest is exactly SHA-256 of those bytes.
  return hash(Buffer.from(data))
}

/** The SEP-53 payload SPP signs: prefix || message, as the bytes to hash. */
export function keyDerivationPayload(): Uint8Array {
  return utf8(SEP53_MESSAGE_PREFIX + KEY_DERIVATION_MESSAGE)
}

/**
 * The two 32-byte seeds SPP's key derivation consumes, straight from the raw
 * signature — `Sha256(domain || signature)` per upstream `encryption.rs`.
 */
export function derivePrivacyKeySeeds(signature: Uint8Array): {
  noteSeed: Uint8Array
  encryptionSeed: Uint8Array
} {
  if (signature.length !== ED25519_SIGNATURE_LENGTH) {
    throw new PrivacyKeyError('Privacy key derivation needs a 64-byte signature.')
  }
  return {
    noteSeed: sha256(concatBytes(utf8(NOTE_KEY_DOMAIN), signature)),
    encryptionSeed: sha256(concatBytes(utf8(ENCRYPTION_KEY_DOMAIN), signature)),
  }
}

/** Result of {@link signPrivacyKeyDerivation}. */
export type PrivacyKeyDerivation = {
  /** The Stellar account (G…) the signature verifies under — the pool owner. */
  ownerAddress: string
  /** Raw 64-byte Ed25519 signature. In-memory only; never stored or sent. */
  signature: Uint8Array
  noteSeed: Uint8Array
  encryptionSeed: Uint8Array
  /**
   * False when the spend key is not re-derivable from a passkey on another
   * device — a legacy or otherwise non-PRF key. Screens must surface the
   * recovery warning from this BEFORE anything is shielded.
   */
  recoverySupported: boolean
}

/**
 * Sign SPP's key-derivation message with an already-established spend key.
 *
 * `keypair.secret()` never leaves this function and the signature is returned
 * for immediate in-memory use — neither is written to any store.
 */
export function signPrivacyKeyDerivation(
  keypair: Keypair,
  opts: { recoverySupported?: boolean } = {},
): PrivacyKeyDerivation {
  const digest = sha256(keyDerivationPayload())
  const signature = keypair.sign(digest)
  if (signature.length !== ED25519_SIGNATURE_LENGTH) {
    throw new PrivacyKeyError('Privacy key derivation needs a 64-byte signature.')
  }
  if (!keypair.verify(digest, signature)) {
    // Unreachable for a real keypair; guards against shipping a signature no
    // SPP node would accept rather than failing silently downstream.
    throw new PrivacyKeyError('Privacy key derivation signature failed self-verification.')
  }
  return {
    ownerAddress: keypair.publicKey(),
    signature,
    ...derivePrivacyKeySeeds(signature),
    recoverySupported: opts.recoverySupported !== false,
  }
}

/**
 * Whether this wallet's privacy keys can be re-derived from its passkey on
 * another device. A pinned `legacy` mode answers "no" with no ceremony at
 * all; a PRF wallet gets one PRF re-check (injectable, and platforms answer
 * PRF challenges silently on already-unlocked devices) — so a screen can warn
 * before the user ever tries to shield.
 */
export async function isPrivacyRecoverySupported(evaluator?: PrfEvaluator): Promise<boolean> {
  const mode = getFeePayerMode()
  if (mode === null) return true // nothing established yet — no wallet to warn about
  if (mode === 'legacy') return false
  // prf-raw / prf-hkdf are PRF-derived by definition; confirm the authenticator
  // still answers with a PRF (a synced passkey can move to a non-PRF device).
  const credentialId = walletLocal.getItem('invisible_wallet_key_id')
  if (!credentialId) return false
  try {
    const prf = await evaluateFeePayerPrf(credentialId, undefined, evaluator)
    return !!prf && prf.length >= 32
  } catch {
    return false
  }
}

/**
 * Produce SPP's key-derivation signature for this session's wallet.
 *
 * The fee payer must already be established (session entry points run
 * `ensureFeePayer`; this never prompts on its own). `legacy` mode is refused
 * outright — see the header for why.
 *
 * @param evaluator injectable PRF ceremony, for tests / re-checks.
 */
export async function preparePrivacySigner(evaluator?: PrfEvaluator): Promise<PrivacyKeyDerivation> {
  const mode = getFeePayerMode()
  if (mode === null) {
    throw new PrivacyKeyError('No wallet is established for this session yet.')
  }
  if (mode === 'legacy') {
    throw new PrivacyKeyError(LEGACY_FEE_PAYER_MESSAGE)
  }
  const keypair = peekFeePayerKeypair()
  if (!keypair) {
    throw new PrivacyKeyError('No wallet is established for this session yet.')
  }
  return signPrivacyKeyDerivation(keypair, {
    recoverySupported: await isPrivacyRecoverySupported(evaluator),
  })
}

/** Copy for a wallet whose spend key is not passkey-bound (banned for signing, V132). */
export const LEGACY_FEE_PAYER_MESSAGE =
  'This wallet’s spend key predates passkey-bound keys, so its privacy keys cannot be re-derived from ' +
  'your passkey on another device. Private payments are available once the wallet is re-established with ' +
  'a PRF-capable passkey.'

/**
 * Screen copy for the recovery notice, phrased for every unsupported case
 * (pinned-legacy wallets and PRF-less passkeys alike). The mobile app's
 * `PRIVACY_RECOVERY_WARNING` carries the same wording.
 */
export const PRIVACY_RECOVERY_WARNING =
  'This wallet’s privacy keys cannot be re-derived from your passkey on another device. ' +
  'Private balances you move in with it are recoverable only on this device — if it is lost, ' +
  'they are lost. To keep them recoverable, use a passkey held by a PRF-capable password ' +
  'manager and create your wallet with it.'
