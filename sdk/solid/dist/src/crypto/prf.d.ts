/**
 * WebAuthn PRF-derived client-side encryption.
 *
 * The WebAuthn PRF extension lets a passkey deterministically derive a
 * high-entropy secret during an assertion. The same credential evaluated with
 * the same salt always yields the same bytes, so we can turn a passkey into a
 * stable symmetric key — encrypting local app data (cached metadata, backup
 * blobs, …) with no password and nothing secret persisted to storage.
 *
 *   PRF output ──HKDF-SHA256──▶ AES-GCM-256 key ──▶ encrypt / decrypt
 *
 * When PRF is unsupported (older browsers/authenticators) we fall back to a
 * locally generated random key persisted through the caller's storage adapter.
 * That key is NOT bound to the passkey and is only as safe as local storage —
 * {@link LocalCipher.mode} reports which path is active so callers can decide
 * whether the weaker guarantee is acceptable.
 */
/** Storage key under which the fallback (non-PRF) symmetric key is persisted. */
export declare const FALLBACK_KEY_STORAGE = "invisible_wallet_local_enc_key";
/**
 * Minimal key–value storage, structurally compatible with the SDK's
 * StorageAdapter (localStorage / AsyncStorage). Used only to persist the
 * fallback key when PRF is unavailable.
 */
export interface PrfSecretStore {
    getItem(key: string): string | null | Promise<string | null>;
    setItem(key: string, value: string): void | Promise<void>;
}
/**
 * Evaluates the WebAuthn PRF extension and returns the raw PRF output bytes for
 * the given salt, or null if the authenticator did not produce a PRF result.
 * Injectable so non-browser platforms and tests can supply their own ceremony.
 */
export type PrfEvaluator = (salt: Uint8Array) => Promise<Uint8Array | null>;
export interface PrfCipherConfig {
    /** Base64url credential ID of the passkey to evaluate PRF against. */
    credentialId: string;
    /** WebAuthn relying party ID. Defaults to the current hostname in the browser. */
    rpId?: string;
    /** Storage adapter used to persist the fallback key when PRF is unavailable. */
    storage?: PrfSecretStore;
    /** Override the PRF ceremony (defaults to a browser navigator.credentials.get). */
    evaluator?: PrfEvaluator;
}
/** A symmetric cipher bound either to the passkey (PRF) or to a local fallback key. */
export interface LocalCipher {
    /** Which key-derivation path is active. 'fallback' is not passkey-bound. */
    readonly mode: 'prf' | 'fallback';
    /** Encrypt bytes or a UTF-8 string; returns base64 (iv ‖ ciphertext). */
    encrypt(plaintext: string | Uint8Array): Promise<string>;
    /** Decrypt a base64 payload produced by {@link encrypt} back to raw bytes. */
    decrypt(payload: string): Promise<Uint8Array>;
    /** Decrypt a base64 payload and decode it as a UTF-8 string. */
    decryptString(payload: string): Promise<string>;
}
/**
 * Best-effort, synchronous check for whether WebAuthn + the Web Crypto subtle
 * API are present. PRF can only be truly confirmed by running an assertion, so
 * {@link createLocalCipher} still falls back at runtime if the ceremony returns
 * no PRF result even when this returns true.
 */
export declare function isPrfSupported(): boolean;
/**
 * Default browser PRF evaluator: runs navigator.credentials.get with the PRF
 * extension and returns the first PRF result, or null when the authenticator
 * did not surface one (PRF unsupported).
 */
export declare function browserPrfEvaluator(credentialId: string, rpId?: string): PrfEvaluator;
/**
 * Derive a non-extractable AES-GCM-256 key from raw PRF output using HKDF-SHA256.
 * Deterministic: the same PRF output always yields a key that decrypts the same
 * ciphertext.
 */
export declare function deriveKeyFromPrf(prfOutput: Uint8Array): Promise<CryptoKey>;
/** Encrypt with AES-GCM; returns base64(iv ‖ ciphertext+tag). */
export declare function encryptWithKey(key: CryptoKey, plaintext: string | Uint8Array): Promise<string>;
/** Decrypt a base64(iv ‖ ciphertext) payload produced by {@link encryptWithKey}. */
export declare function decryptWithKey(key: CryptoKey, payload: string): Promise<Uint8Array>;
/**
 * Build a {@link LocalCipher} for the given passkey credential.
 *
 * Attempts a PRF assertion first; if PRF is unsupported (or the ceremony
 * returns no result) it falls back to a random key persisted via `storage`.
 * The derived key is cached on the returned cipher, so the (interactive) PRF
 * ceremony runs at most once per cipher instance.
 *
 * @throws if PRF is unavailable AND no `storage` adapter was provided — there is
 *         then no safe place to keep a fallback key.
 */
export declare function createLocalCipher(config: PrfCipherConfig): Promise<LocalCipher>;
