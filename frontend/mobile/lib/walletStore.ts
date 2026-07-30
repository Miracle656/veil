import * as SecureStore from 'expo-secure-store';

/**
 * Thin accessors for the wallet identifiers the app keeps on the device.
 *
 * The browser wallet reads these from `sessionStorage` / `localStorage`; on
 * mobile they live in the OS keychain (`expo-secure-store`) so the fee-payer
 * secret is never written to plain application storage.
 */

const WALLET_ADDRESS_KEY = 'invisible_wallet_address';
const PASSKEY_ID_KEY = 'invisible_wallet_key_id';
const PASSKEY_PUBLIC_KEY = 'invisible_wallet_public_key';
const SIGNER_SECRET_KEY = 'veil_signer_secret';

async function read(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch (error) {
    console.warn(`[walletStore] failed to read "${key}"`, error);
    return null;
  }
}

/** Deployed wallet contract address (`C...`), or null when not yet created. */
export function getWalletAddress(): Promise<string | null> {
  return read(WALLET_ADDRESS_KEY);
}

export function setWalletAddress(address: string): Promise<void> {
  return SecureStore.setItemAsync(WALLET_ADDRESS_KEY, address);
}

/** Base64url credential id of the registered passkey. */
export function getPasskeyId(): Promise<string | null> {
  return read(PASSKEY_ID_KEY);
}

/** Hex-encoded secp256r1 public key of the registered passkey. */
export function getPasskeyPublicKey(): Promise<string | null> {
  return read(PASSKEY_PUBLIC_KEY);
}

/** Stellar secret seed of the account that pays fees for wallet transactions. */
export function getSignerSecret(): Promise<string | null> {
  return read(SIGNER_SECRET_KEY);
}
