/**
 * Secure on-device storage — the one helper the app routes sensitive wallet
 * data through.
 *
 * The browser wallet keeps its credentials in `localStorage` / `sessionStorage`;
 * on mobile that plain, unencrypted storage isn't acceptable for secrets. This
 * wraps `expo-secure-store` (iOS Keychain / Android Keystore) so wallet metadata
 * — credential id, contract address, public key — and the fee-payer secret live
 * in the platform secure enclave and survive relaunch, while never landing in
 * AsyncStorage or any plaintext store.
 *
 * Reads fail soft (a keychain error logs and returns `null`) so a transient
 * read never crashes a screen; writes surface their errors to the caller.
 */

import * as SecureStore from 'expo-secure-store';

/**
 * Canonical keys for the sensitive values kept in the keychain. Centralised here
 * so every reader and writer agrees on them (the values mirror the keys the web
 * wallet writes, so a backup from either client describes the same wallet). Keys
 * must match SecureStore's allowed set (`[A-Za-z0-9._-]`).
 */
export const SecureKey = {
  walletAddress: 'invisible_wallet_address',
  passkeyId: 'invisible_wallet_key_id',
  passkeyPublicKey: 'invisible_wallet_public_key',
  signerSecret: 'veil_signer_secret',
} as const;

export type SecureKey = (typeof SecureKey)[keyof typeof SecureKey];

/**
 * Read a string from the keychain, or `null` when absent or on a read error.
 *
 * Android's keystore intermittently fails CONCURRENT reads (several screens
 * resolve wallet state at once on mount), and a transient failure that reads
 * as "no wallet" mis-routes the whole app (splash → welcome, login → fresh
 * recovery, assets → empty). Retry briefly before giving up.
 */
export async function getSecureItem(key: string): Promise<string | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await SecureStore.getItemAsync(key);
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 120 * (attempt + 1)));
    }
  }
  console.warn(`[storage] failed to read "${key}" after retries`, lastError);
  return null;
}

/** Persist a string to the keychain. Errors propagate to the caller. */
export function setSecureItem(key: string, value: string): Promise<void> {
  return SecureStore.setItemAsync(key, value);
}

/** Remove a value from the keychain. */
export function deleteSecureItem(key: string): Promise<void> {
  return SecureStore.deleteItemAsync(key);
}

/**
 * Read and parse a JSON value from the keychain. Returns `null` when the key is
 * absent, unreadable, or holds malformed JSON — corrupt data never throws.
 */
export async function getSecureJSON<T>(key: string): Promise<T | null> {
  const raw = await getSecureItem(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    console.warn(`[storage] failed to parse JSON at "${key}"`, error);
    return null;
  }
}

/** Serialise and persist a JSON value to the keychain. */
export function setSecureJSON(key: string, value: unknown): Promise<void> {
  return setSecureItem(key, JSON.stringify(value));
}
