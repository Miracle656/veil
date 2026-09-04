import { SecureKey, getSecureItem, setSecureItem, deleteSecureItem } from './storage';
import { getNetworkName, hydrateNetwork } from './network';

/**
 * Thin, typed accessors for the wallet identifiers the app keeps on the device.
 *
 * The browser wallet reads these from `sessionStorage` / `localStorage`; on
 * mobile they all route through the secure store (`lib/storage.ts`, backed by the
 * OS keychain), so wallet metadata survives relaunch and the fee-payer secret is
 * never written to plain application storage.
 *
 * PER-NETWORK NAMESPACING: mainnet and testnet each get their own wallet.
 * Testnet keeps the historical unsuffixed keys (back-compat with existing
 * installs); mainnet keys carry a `_mainnet` suffix. Without this, switching
 * networks showed the other network's wallet, and a "Reset wallet" on testnet
 * would have destroyed a REAL-funds mainnet wallet.
 */
async function key(base: SecureKey): Promise<string> {
  // The network override is read from storage at startup; awaiting hydration
  // prevents a cold-start race from reading the wrong network's keys.
  await hydrateNetwork();
  return getNetworkName() === 'mainnet' ? `${base}_mainnet` : base;
}

/** Deployed wallet contract address (`C...`), or null when not yet created. */
export async function getWalletAddress(): Promise<string | null> {
  return getSecureItem(await key(SecureKey.walletAddress));
}

export async function setWalletAddress(address: string): Promise<void> {
  return setSecureItem(await key(SecureKey.walletAddress), address);
}

/** Base64url credential id of the registered passkey. */
export async function getPasskeyId(): Promise<string | null> {
  return getSecureItem(await key(SecureKey.passkeyId));
}

export async function setPasskeyId(keyId: string): Promise<void> {
  return setSecureItem(await key(SecureKey.passkeyId), keyId);
}

/** Hex-encoded secp256r1 public key of the registered passkey. */
export async function getPasskeyPublicKey(): Promise<string | null> {
  return getSecureItem(await key(SecureKey.passkeyPublicKey));
}

export async function setPasskeyPublicKey(publicKey: string): Promise<void> {
  return setSecureItem(await key(SecureKey.passkeyPublicKey), publicKey);
}

/**
 * Adopt a passkey as this device's wallet credential.
 *
 * Both halves are written together — a credential id without its public key
 * produces assertions the wallet contract cannot verify.
 */
export async function setPasskeyCredential(keyId: string, publicKeyHex: string): Promise<void> {
  await Promise.all([setPasskeyId(keyId), setPasskeyPublicKey(publicKeyHex)]);
}

/** Stellar secret seed of the account that pays fees for wallet transactions. */
export async function getSignerSecret(): Promise<string | null> {
  return getSecureItem(await key(SecureKey.signerSecret));
}

export async function setSignerSecret(secret: string): Promise<void> {
  return setSecureItem(await key(SecureKey.signerSecret), secret);
}

/** Wipe the ACTIVE NETWORK's stored wallet identifiers only. */
export async function clearWalletStore(): Promise<void> {
  await Promise.all([
    key(SecureKey.walletAddress).then(deleteSecureItem),
    key(SecureKey.passkeyId).then(deleteSecureItem),
    key(SecureKey.passkeyPublicKey).then(deleteSecureItem),
    key(SecureKey.signerSecret).then(deleteSecureItem),
  ]);
}
