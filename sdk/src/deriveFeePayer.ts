import { Keypair } from '@stellar/stellar-sdk';

/**
 * Deterministically derive a fee-payer Ed25519 keypair from a WebAuthn credential ID.
 *
 * SECURITY (known limitation — see docs/NON_PRF_FEE_PAYER_EXPOSURE.md and docs/adr/0003-fee-payer-key-from-webauthn-prf.md):
 * **The WebAuthn credential ID is not a secret.**
 *
 * Exposure paths in practice:
 * 1. Storage: The credential ID is stored in cleartext in client storage
 *    (`invisible_wallet_key_id` in localStorage or mobile device storage). Any
 *    script executing in the application origin (e.g. XSS), malicious browser
 *    extension, or local disk inspection can read it directly.
 * 2. Ceremonies: The credential ID is transmitted in `publicKey.allowCredentials`
 *    on every WebAuthn assertion (unlock, transaction signing), visible to devtools,
 *    DOM observers, and platform authenticators.
 * 3. Scope: While WebAuthn scopes credentials to the Relying Party (RP ID) and does
 *    not broadcast them across domains, within the client application origin the
 *    credential ID is treated as a public descriptor, not a secret.
 *
 * This derivation therefore does **not** bind the resulting key to a biometric:
 * anyone who can read the credential ID can reconstruct this exact keypair with
 * no passkey prompt.
 *
 * Blast radius:
 * - Smart wallet (Soroban contract): The smart wallet's funds are guarded by the
 *   passkey through contract `__check_auth`. Only the fee payer's gas balance
 *   is exposed.
 * - Keypair wallet: The account holds everything. Deriving a keypair wallet from
 *   a credential ID results in total loss of funds.
 *
 * Current Architecture & Migration:
 * - Passkey-bound wallets derive fee-payer keys using the WebAuthn PRF extension
 *   (`evaluateFeePayerPrf` / `deriveFeePayerSeedFromPrf` using `FEE_PAYER_PRF_SALT`).
 * - For authenticators without PRF support, new wallets generate a secure random
 *   keypair (`Keypair.random()`) stored locally, stopping public-value derivation
 *   where an alternative exists.
 * - This function is retained strictly for backward compatibility: to probe and
 *   preserve pre-existing legacy fee-payer accounts on-chain so existing funded
 *   accounts are not stranded. Do not use it to establish new wallets or to derive
 *   keys that guard value.
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
