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
 * Veil's spend key is the same Ed25519 keypair the app pays fees with, whose
 * 32-byte seed is the passkey's WebAuthn PRF output under `FEE_PAYER_PRF_SALT`
 * — so the same passkey yields the same privacy keys on every device, and
 * recovering the wallet re-derives them with no extra backup. This module
 * produces the signature and SPP's exact key seeds; materialising the BN254 /
 * X25519 keys from those seeds is the SPP client's job (V134/V141).
 *
 * Cross-platform convention: `frontend/wallet/lib/privacy/keys.ts` is the
 * web twin. Both suites pin the same golden vector
 * (`__tests__/keys.test.ts`): same PRF output → same signature → same seeds.
 *
 * Nothing here is persisted: the signature lives only in the returned object
 * for the duration of the derivation call, and neither key, note nor signature
 * is ever logged or sent anywhere (docs/PRIVACY_THREAT_MODEL.md §4).
 */

import { Keypair, hash } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

import { evaluatePrf } from '../passkey';
import { PrivacyError } from '../privacy';
import { getPasskeyId, getSignerSecret } from '../walletStore';

/** The message SPP signs to derive privacy keys. Must match upstream byte-for-byte. */
export const KEY_DERIVATION_MESSAGE = 'Privacy Pool Key Derivation [v1]';

/** SEP-53 framing, as in upstream `encryption.rs` (`SEP53_MESSAGE_PREFIX`). */
export const SEP53_MESSAGE_PREFIX = 'Stellar Signed Message:\n';

/** Domain separators for each derived key, as in upstream `encryption.rs`. */
export const NOTE_KEY_DOMAIN = 'privacy-pool/note-key/v1';
export const ENCRYPTION_KEY_DOMAIN = 'privacy-pool/encryption-key/v1';
export const MEMBERSHIP_BLINDING_DOMAIN = 'privacy-pool/asp-secret/v1';

/** Upstream rejects any key-derivation signature that is not exactly this long. */
const ED25519_SIGNATURE_LENGTH = 64;

/**
 * Same PRF salt the fee-payer seed was derived with — what makes the ceremony
 * reproduce this device's stored spend key. Mirrors the SDK's
 * `FEE_PAYER_PRF_SALT`, as `passkeyWallet.ts` / `passkeyLogin.ts` do.
 */
const FEE_PAYER_PRF_SALT = new Uint8Array(new TextEncoder().encode('invisible-wallet/prf/feepayer/v1'));

function utf8(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'utf8'));
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function sha256(data: Uint8Array): Buffer {
  // stellar-base types `hash` as Buffer in/out; wrapping the bytes is a view,
  // not a copy, so the digest is exactly SHA-256 of those bytes.
  return hash(Buffer.from(data));
}

/** The SEP-53 payload SPP signs: prefix || message, as the raw bytes to hash. */
export function keyDerivationPayload(): Uint8Array {
  return utf8(SEP53_MESSAGE_PREFIX + KEY_DERIVATION_MESSAGE);
}

/**
 * The two 32-byte seeds SPP's key derivation consumes, straight from the raw
 * signature — `Sha256(domain || signature)` per upstream `encryption.rs`.
 * (The membership-blinding seed is upstream's third domain, provided for the
 * client's ASP-membership leaf.)
 */
export function derivePrivacyKeySeeds(signature: Uint8Array): {
  noteSeed: Uint8Array;
  encryptionSeed: Uint8Array;
} {
  if (signature.length !== ED25519_SIGNATURE_LENGTH) {
    throw new PrivacyError('Privacy key derivation needs a 64-byte signature.');
  }
  return {
    noteSeed: sha256(concatBytes(utf8(NOTE_KEY_DOMAIN), signature)),
    encryptionSeed: sha256(concatBytes(utf8(ENCRYPTION_KEY_DOMAIN), signature)),
  };
}

/** What `preparePrivacySigner` found: SPP's inputs, plus how they came to be. */
export type PrivacySignerRequest = {
  /** The Stellar account (G…) the signature verifies under — the pool owner. */
  ownerAddress: string;
  /** Raw 64-byte Ed25519 signature. In-memory only; never stored or sent. */
  signature: Uint8Array;
  noteSeed: Uint8Array;
  encryptionSeed: Uint8Array;
};

/** Result of {@link signPrivacyKeyDerivation}. */
export type PrivacyKeyDerivation = PrivacySignerRequest & {
  /**
   * False when the spend key is not re-derivable from a passkey on another
   * device (keypair-mode wallet, random fallback, or a PRF-less passkey) —
   * the case the shield screen must warn about BEFORE anything is shielded.
   */
  recoverySupported: boolean;
};

/**
 * Sign SPP's key-derivation message with the wallet's spend key.
 *
 * `keypair.secret()` never leaves this function and the signature is returned
 * for immediate in-memory use — neither is written to any store.
 */
export function signPrivacyKeyDerivation(
  keypair: Keypair,
  opts: { recoverySupported?: boolean } = {},
): PrivacyKeyDerivation {
  const digest = sha256(keyDerivationPayload());
  const signature = keypair.sign(digest);
  if (signature.length !== ED25519_SIGNATURE_LENGTH) {
    throw new PrivacyError('Privacy key derivation needs a 64-byte signature.');
  }
  if (!keypair.verify(digest, signature)) {
    // Unreachable for a real keypair; guards against shipping a signature no
    // SPP node would accept rather than failing silently downstream.
    throw new PrivacyError('Privacy key derivation signature failed self-verification.');
  }
  return {
    ownerAddress: keypair.publicKey(),
    signature,
    ...derivePrivacyKeySeeds(signature),
    recoverySupported: opts.recoverySupported !== false,
  };
}

/** Whether the stored spend key is the passkey-PRF-derived one (runs the ceremony once). */
async function boundToPasskey(): Promise<boolean> {
  const [secret, keyId] = await Promise.all([getSignerSecret(), getPasskeyId()]);
  if (!secret || !keyId) return false;
  const result = await evaluatePrf(keyId, FEE_PAYER_PRF_SALT);
  if (result.outcome !== 'ok' || !result.output) return false;
  try {
    return Keypair.fromRawEd25519Seed(Buffer.from(result.output.subarray(0, 32))).publicKey() ===
      Keypair.fromSecret(secret).publicKey();
  } catch {
    return false;
  }
}

/**
 * Whether this wallet's privacy keys can be re-derived from its passkey on
 * another device. Runs the PRF ceremony — a biometric prompt — at most once
 * per call, and any doubt (error, cancel, drift) answers "no", so the warning
 * can never be skipped by a failure. The shield screen calls this BEFORE the
 * user is allowed to confirm anything.
 */
export async function isPrivacyRecoverySupported(): Promise<boolean> {
  try {
    return await boundToPasskey();
  } catch {
    return false;
  }
}

/**
 * Produce SPP's key-derivation signature for this device's wallet.
 *
 * - Passkey wallet: runs the PRF ceremony to derive the spend key fresh — the
 *   same key the app persists after registration — and reports
 *   `recoverySupported: true`.
 * - A PRF-less passkey (e.g. Samsung Pass): the signature cannot be produced
 *   here at all; the thrown {@link NO_PRF_PASSKEY_MESSAGE} says why in the
 *   user's terms, and `isPrivacyRecoverySupported` gives the shield screen the
 *   same answer without needing a signature first.
 * - Ceremony cancelled: throws a plain error — retryable, not a warning.
 * - Keypair-mode wallet (testnet quick create): signs with the stored key and
 *   reports `recoverySupported: false` — those keys live in this device's
 *   keychain only.
 */
export async function preparePrivacySigner(ownerAddress?: string): Promise<PrivacyKeyDerivation> {
  const [secret, keyId] = await Promise.all([getSignerSecret(), getPasskeyId()]);
  if (!secret && !keyId) {
    throw new PrivacyError('This device holds no wallet to derive privacy keys from.');
  }
  const stored = secret ? Keypair.fromSecret(secret) : null;

  if (keyId) {
    const result = await evaluatePrf(keyId, FEE_PAYER_PRF_SALT);
    if (result.outcome === 'ok' && result.output) {
      const derived = Keypair.fromRawEd25519Seed(Buffer.from(result.output.subarray(0, 32)));
      if (stored && stored.publicKey() !== derived.publicKey()) {
        // The stored signer is not the passkey-derived one (random fallback,
        // or it was replaced). The passkey still re-derives `derived` on every
        // device, so privacy keys follow the passkey — but flag the mismatch
        // loudly rather than silently signing a key the user thinks is gone.
        console.warn('[privacy] stored signer differs from the passkey-derived key; privacy keys follow the passkey');
      }
      if (ownerAddress && derived.publicKey() !== ownerAddress) {
        throw new PrivacyError('This passkey does not control the requested account.');
      }
      return signPrivacyKeyDerivation(derived, { recoverySupported: true });
    }
    if (result.outcome === 'unsupported') {
      throw new PrivacyError(NO_PRF_PASSKEY_MESSAGE);
    }
    if (result.outcome === 'cancelled') {
      throw new Error('Passkey cancelled. Please try again.');
    }
    throw new Error(result.detail ?? 'Passkey verification failed.');
  }

  if (!stored) throw new PrivacyError('This device holds no wallet to derive privacy keys from.');
  if (ownerAddress && stored.publicKey() !== ownerAddress) {
    throw new PrivacyError('This device holds no key for the requested account.');
  }
  return signPrivacyKeyDerivation(stored, { recoverySupported: false });
}

/** Copy for a wallet whose passkey cannot re-derive its privacy keys elsewhere. */
export const NO_PRF_PASSKEY_MESSAGE =
  'This passkey does not support the PRF extension (e.g. Samsung Pass), so your privacy keys cannot be ' +
  're-derived from it on another device — private balances shielded with it are recoverable only on this ' +
  'device. Create a passkey with a PRF-capable manager to keep them recoverable.';

/**
 * Screen copy for the pre-action warning, deliberately generic: it must fit
 * every unsupported case — including a keypair-mode wallet, which has no
 * passkey at all.
 */
export const PRIVACY_RECOVERY_WARNING =
  'This wallet’s privacy keys cannot be re-derived from your passkey on another device. ' +
  'Private balances you move in with it are recoverable only on this device — if it is lost, ' +
  'they are lost. To keep them recoverable, use a passkey held by a PRF-capable password ' +
  'manager and create your wallet with it.';
