import { Keypair } from '@stellar/stellar-sdk';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { getPasskeyId } from './walletStore';

/**
 * Deterministically derive the fee-payer (sponsor) Ed25519 keypair from a
 * passkey credential id — the native port of the web wallet's
 * `lib/deriveFeePayer.ts`.
 *
 * SECURITY (known limitation — see docs/adr/0003-fee-payer-key-from-webauthn-prf.md):
 * the credential id is NOT a secret (it is stored in the keychain and returned in
 * every assertion's allowCredentials), so this derivation is not passkey-bound —
 * anyone who can read the credential id can reconstruct this keypair. Blast radius
 * is the G… fee account only. The planned fix derives the seed from a WebAuthn PRF
 * output instead. Do not add callers that rely on this being biometric-gated.
 *
 * The wallet is fee-sponsored, so this account must be **byte-identical** on web
 * and native: a mismatch would pay fees from the wrong account. The web derives
 * the seed with WebCrypto HKDF (`crypto.subtle`); React Native has no equivalent
 * under its crypto polyfills, so this uses `@noble/hashes` HKDF instead. HKDF
 * (RFC 5869) is a fixed standard, so noble's HKDF-SHA-256 produces the same
 * 32 bytes as WebCrypto for the same inputs — verified against a golden address
 * derived through the web path (see `__tests__/deriveFeePayer.test.ts`).
 *
 * Derivation:
 *   - IKM  = raw credential id bytes
 *   - salt = fixed domain string, to prevent cross-app collisions
 *   - info = version tag, so the scheme can be rotated
 * The 32-byte output is used directly as the Ed25519 seed.
 */

function utf8(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'utf8'));
}

// Must match the web wallet's salt/info byte-for-byte.
const SALT = utf8('veil:feepayer:salt:v1');
const INFO = utf8('veil:feepayer:ed25519:v1');

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(Buffer.from(padded, 'base64'));
}

/**
 * Derive the fee-payer keypair from a base64url-encoded credential id. Pure and
 * synchronous — noble's HKDF needs no async crypto — and stable: the same
 * credential id always yields the same keypair.
 */
export function deriveFeePayerKeypair(credentialIdBase64url: string): Keypair {
  const ikm = base64UrlToBytes(credentialIdBase64url);
  const seed = hkdf(sha256, ikm, SALT, INFO, 32); // 32 bytes = Ed25519 seed
  return Keypair.fromRawEd25519Seed(Buffer.from(seed));
}

/**
 * Convenience: derive the fee-payer from the credential id kept on this device
 * (secure store). Returns null when no passkey is registered.
 */
export async function deriveStoredFeePayer(): Promise<Keypair | null> {
  const keyId = await getPasskeyId();
  if (!keyId) return null;
  return deriveFeePayerKeypair(keyId);
}
