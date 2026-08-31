import { Keypair } from '@stellar/stellar-sdk';

/**
 * Deterministically derive a fee-payer Ed25519 keypair from a WebAuthn credential ID.
 *
 * Uses HKDF (RFC 5869) with SHA-256:
 *   - IKM  = raw credential ID bytes
 *   - salt = fixed domain string ('veil:feepayer:salt:v1')
 *   - info = version tag ('veil:feepayer:ed25519:v1')
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
