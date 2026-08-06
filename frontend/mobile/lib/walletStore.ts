import { SecureKey, getSecureItem, setSecureItem, deleteSecureItem } from './storage';

/**
 * Thin, typed accessors for the wallet identifiers the app keeps on the device.
 *
 * The browser wallet reads these from `sessionStorage` / `localStorage`; on
 * mobile they all route through the secure store (`lib/storage.ts`, backed by the
 * OS keychain), so wallet metadata survives relaunch and the fee-payer secret is
 * never written to plain application storage.
 */

/** Deployed wallet contract address (`C...`), or null when not yet created. */
export function getWalletAddress(): Promise<string | null> {
  return getSecureItem(SecureKey.walletAddress);
}

export function setWalletAddress(address: string): Promise<void> {
  return setSecureItem(SecureKey.walletAddress, address);
}

/** Base64url credential id of the registered passkey. */
export function getPasskeyId(): Promise<string | null> {
  return getSecureItem(SecureKey.passkeyId);
}

export function setPasskeyId(keyId: string): Promise<void> {
  return setSecureItem(SecureKey.passkeyId, keyId);
}

/** Hex-encoded secp256r1 public key of the registered passkey. */
export function getPasskeyPublicKey(): Promise<string | null> {
  return getSecureItem(SecureKey.passkeyPublicKey);
}

export function setPasskeyPublicKey(publicKey: string): Promise<void> {
  return setSecureItem(SecureKey.passkeyPublicKey, publicKey);
}

/**
 * Adopt a passkey as this device's wallet credential.
 *
 * Both halves are written together — a credential id without its public key
 * produces assertions the wallet contract cannot verify.
 */
export async function setPasskeyCredential(keyId: string, publicKeyHex: string): Promise<void> {
  await Promise.all([
    setSecureItem(SecureKey.passkeyId, keyId),
    setSecureItem(SecureKey.passkeyPublicKey, publicKeyHex),
  ]);
}

/** Stellar secret seed of the account that pays fees for wallet transactions. */
export function getSignerSecret(): Promise<string | null> {
  return getSecureItem(SecureKey.signerSecret);
}

export function setSignerSecret(secret: string): Promise<void> {
  return setSecureItem(SecureKey.signerSecret, secret);
}

/** Wipe every stored wallet identifier — used when clearing the wallet. */
export async function clearWalletStore(): Promise<void> {
  await Promise.all([
    deleteSecureItem(SecureKey.walletAddress),
    deleteSecureItem(SecureKey.passkeyId),
    deleteSecureItem(SecureKey.passkeyPublicKey),
    deleteSecureItem(SecureKey.signerSecret),
  ]);
}
