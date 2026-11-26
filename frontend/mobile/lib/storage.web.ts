/**
 * Web build of the on-device store — the counterpart to `./storage.ts`.
 *
 * Metro resolves this `.web.ts` variant on the web target. The browser has no
 * Keychain/Keystore, and `expo-secure-store`'s native methods don't exist there
 * (calling them throws `ExpoSecureStore.default.getValueWithKeyAsync is not a
 * function`), so wallet metadata falls back to `localStorage` — the same store
 * the web wallet (`frontend/wallet`) already uses. The keys are identical to the
 * native file's, so a wallet described on one surface reads the same on the
 * other.
 *
 * NOTE: `localStorage` is not hardware-secure. This exists so the app is
 * functional on web (previews and the eventual PWA); the security model for the
 * fee-payer key on web is handled separately (WebAuthn PRF, per the web wallet).
 */

/** Canonical keys for the values kept on-device. Mirrors `./storage.ts`. */
export const SecureKey = {
  walletAddress: 'invisible_wallet_address',
  passkeyId: 'invisible_wallet_key_id',
  passkeyPublicKey: 'invisible_wallet_public_key',
  signerSecret: 'veil_signer_secret',
} as const;

export type SecureKey = (typeof SecureKey)[keyof typeof SecureKey];

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // access can throw in sandboxed contexts
  }
}

/** Read a string, or `null` when absent or on a read error. */
export async function getSecureItem(key: string): Promise<string | null> {
  try {
    return store()?.getItem(key) ?? null;
  } catch (error) {
    console.warn(`[storage] failed to read "${key}"`, error);
    return null;
  }
}

/** Persist a string. Errors propagate to the caller. */
export function setSecureItem(key: string, value: string): Promise<void> {
  const s = store();
  if (!s) return Promise.reject(new Error('localStorage is unavailable'));
  s.setItem(key, value);
  return Promise.resolve();
}

/** Remove a value. */
export function deleteSecureItem(key: string): Promise<void> {
  store()?.removeItem(key);
  return Promise.resolve();
}

/** Read and parse a JSON value. Returns `null` when absent or malformed. */
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

/** Serialise and persist a JSON value. */
export function setSecureJSON(key: string, value: unknown): Promise<void> {
  return setSecureItem(key, JSON.stringify(value));
}
