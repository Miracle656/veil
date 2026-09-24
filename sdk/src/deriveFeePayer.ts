import { Keypair } from '@stellar/stellar-sdk';

/**
 * Deterministically derive a fee-payer Ed25519 keypair from a WebAuthn credential ID.
 *
 * SECURITY (known limitation — see docs/adr/0003-fee-payer-key-from-webauthn-prf.md):
 * **The WebAuthn credential ID is not a secret.** It is stored in plaintext, is
 * returned in `allowCredentials` on every assertion, and is observable by any
 * relying party. This derivation therefore does **not** bind the resulting key
 * to a biometric: anyone who can read the credential ID can reconstruct this
 * exact keypair with no passkey prompt.
 *
 * The blast radius is the G… fee account only — the C… contract holds the
 * funds — but this is weaker than a "no private keys" reading of the SDK would
 * suggest. Do not add callers that rely on this being passkey-bound, and do not
 * use it to derive anything that guards value. The planned replacement (ADR
 * 0003) derives the seed from a WebAuthn PRF output, a value only the passkey
 * can produce; see `FEE_PAYER_PRF_SALT` and the `prf-*` derivation modes.
 *
 * This caveat travels with the function deliberately. It is now a public export
 * of this package, so a consumer reading only the signature would otherwise
 * have no way to learn any of the above.
 *
 * The derivation uses HKDF (RFC 5869) with SHA-256:
 *   - IKM  = raw credential ID bytes
 *   - salt = fixed domain string ('veil:feepayer:salt:v1'), to prevent
 *            cross-app collisions
 *   - info = version tag ('veil:feepayer:ed25519:v1'), so the scheme can be
 *            rotated
 *
 * The 32-byte HKDF output is used as an Ed25519 seed.
 */
const SALT = new TextEncoder().encode('veil:feepayer:salt:v1');
const INFO = new TextEncoder().encode('veil:feepayer:ed25519:v1');

function base64UrlToUint8Array(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  if (typeof atob === 'function') {
    const binary = atob(padded);
    const rawId = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) rawId[i] = binary.charCodeAt(i);
    return rawId;
  }
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

/**
 * Derive a Stellar Keypair from a base64url-encoded WebAuthn credential ID.
 */
export async function deriveFeePayerKeypair(credentialIdBase64url: string): Promise<Keypair> {
  const rawId = base64UrlToUint8Array(credentialIdBase64url);

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('WebCrypto subtle is required for fee-payer derivation');
  }

  const keyMaterial = await subtle.importKey('raw', rawId as unknown as BufferSource, 'HKDF', false, ['deriveBits']);

  const derived = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: INFO },
    keyMaterial,
    256, // 32 bytes = Ed25519 seed
  );

  return Keypair.fromRawEd25519Seed(Buffer.from(derived));
}
