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

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * Fixed PRF evaluation salt. Keeping it constant is what makes the derived key
 * stable across sessions for a given credential — the authenticator returns the
 * same PRF output for the same (credential, salt) pair every time.
 */
const PRF_SALT = new TextEncoder().encode('invisible-wallet/prf/v1');

/** HKDF context string, separating this key from any other use of the PRF output. */
const HKDF_INFO = new TextEncoder().encode('invisible-wallet/local-encryption/v1');

/** AES-GCM IV length in bytes (96-bit nonce, as recommended for GCM). */
const IV_LENGTH = 12;

/** Storage key under which the fallback (non-PRF) symmetric key is persisted. */
export const FALLBACK_KEY_STORAGE = 'invisible_wallet_local_enc_key';

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── Base64 helpers ──────────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

function base64urlToBytes(b64url: string): Uint8Array {
    const std = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = std + '='.repeat((4 - (std.length % 4)) % 4);
    return base64ToBytes(padded);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// ── Feature detection ─────────────────────────────────────────────────────────

/**
 * Best-effort, synchronous check for whether WebAuthn + the Web Crypto subtle
 * API are present. PRF can only be truly confirmed by running an assertion, so
 * {@link createLocalCipher} still falls back at runtime if the ceremony returns
 * no PRF result even when this returns true.
 */
export function isPrfSupported(): boolean {
    return (
        typeof globalThis !== 'undefined' &&
        typeof (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential !== 'undefined' &&
        typeof globalThis.crypto !== 'undefined' &&
        typeof globalThis.crypto.subtle !== 'undefined' &&
        typeof navigator !== 'undefined' &&
        !!navigator.credentials
    );
}

// ── Browser PRF ceremony ────────────────────────────────────────────────────

/**
 * Default browser PRF evaluator: runs navigator.credentials.get with the PRF
 * extension and returns the first PRF result, or null when the authenticator
 * did not surface one (PRF unsupported).
 */
export function browserPrfEvaluator(credentialId: string, rpId?: string): PrfEvaluator {
    return async (salt: Uint8Array): Promise<Uint8Array | null> => {
        const credId = base64urlToBytes(credentialId);
        const challenge = globalThis.crypto.getRandomValues(new Uint8Array(32));

        const assertion = (await navigator.credentials.get({
            publicKey: {
                challenge: toArrayBuffer(challenge),
                allowCredentials: [{ id: toArrayBuffer(credId), type: 'public-key' }],
                userVerification: 'required',
                ...(rpId ? { rpId } : {}),
                extensions: { prf: { eval: { first: toArrayBuffer(salt) } } } as AuthenticationExtensionsClientInputs,
            },
        })) as PublicKeyCredential | null;

        if (!assertion) throw new Error('PRF assertion was cancelled');

        const results = assertion.getClientExtensionResults() as {
            prf?: { results?: { first?: ArrayBuffer | ArrayBufferView } };
        };
        const first = results.prf?.results?.first;
        if (!first) return null;

        return first instanceof ArrayBuffer ? new Uint8Array(first) : new Uint8Array(first.buffer);
    };
}

// ── Key derivation ────────────────────────────────────────────────────────────

/**
 * Derive a non-extractable AES-GCM-256 key from raw PRF output using HKDF-SHA256.
 * Deterministic: the same PRF output always yields a key that decrypts the same
 * ciphertext.
 */
export async function deriveKeyFromPrf(prfOutput: Uint8Array): Promise<CryptoKey> {
    const baseKey = await globalThis.crypto.subtle.importKey(
        'raw', toArrayBuffer(prfOutput), 'HKDF', false, ['deriveKey']
    );
    return globalThis.crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: HKDF_INFO },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

/** Import a raw 32-byte key as an AES-GCM-256 key (used for the fallback path). */
async function importRawAesKey(raw: Uint8Array): Promise<CryptoKey> {
    return globalThis.crypto.subtle.importKey(
        'raw', toArrayBuffer(raw), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
}

// ── Encrypt / decrypt primitives ──────────────────────────────────────────────

/** Encrypt with AES-GCM; returns base64(iv ‖ ciphertext+tag). */
export async function encryptWithKey(key: CryptoKey, plaintext: string | Uint8Array): Promise<string> {
    const data = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext;
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const ct = new Uint8Array(
        await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, toArrayBuffer(data))
    );
    const combined = new Uint8Array(iv.length + ct.length);
    combined.set(iv, 0);
    combined.set(ct, iv.length);
    return bytesToBase64(combined);
}

/** Decrypt a base64(iv ‖ ciphertext) payload produced by {@link encryptWithKey}. */
export async function decryptWithKey(key: CryptoKey, payload: string): Promise<Uint8Array> {
    const combined = base64ToBytes(payload);
    if (combined.length <= IV_LENGTH) throw new Error('Ciphertext too short');
    const iv = combined.slice(0, IV_LENGTH);
    const ct = combined.slice(IV_LENGTH);
    const plain = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, toArrayBuffer(ct));
    return new Uint8Array(plain);
}

// ── Fallback key management ─────────────────────────────────────────────────

/** Load the persisted fallback key, or generate, persist, and return a fresh one. */
async function loadOrCreateFallbackKey(storage: PrfSecretStore): Promise<Uint8Array> {
    const existing = await storage.getItem(FALLBACK_KEY_STORAGE);
    if (existing) return base64ToBytes(existing);
    const raw = globalThis.crypto.getRandomValues(new Uint8Array(32));
    await storage.setItem(FALLBACK_KEY_STORAGE, bytesToBase64(raw));
    return raw;
}

// ── High-level factory ────────────────────────────────────────────────────────

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
export async function createLocalCipher(config: PrfCipherConfig): Promise<LocalCipher> {
    const { credentialId, rpId, storage } = config;
    const evaluator = config.evaluator
        ?? (isPrfSupported() ? browserPrfEvaluator(credentialId, rpId) : null);

    let key: CryptoKey;
    let mode: 'prf' | 'fallback';

    let prfOutput: Uint8Array | null = null;
    if (evaluator) {
        try {
            prfOutput = await evaluator(PRF_SALT);
        } catch (err) {
            // A genuine cancellation should surface; a missing-PRF failure falls back.
            if (!storage) throw err;
            prfOutput = null;
        }
    }

    if (prfOutput && prfOutput.length > 0) {
        key = await deriveKeyFromPrf(prfOutput);
        mode = 'prf';
    } else {
        if (!storage) {
            throw new Error(
                'WebAuthn PRF is unavailable and no storage adapter was provided for a fallback key.'
            );
        }
        key = await importRawAesKey(await loadOrCreateFallbackKey(storage));
        mode = 'fallback';
    }

    return {
        mode,
        encrypt: (plaintext) => encryptWithKey(key, plaintext),
        decrypt: (payload) => decryptWithKey(key, payload),
        decryptString: async (payload) => new TextDecoder().decode(await decryptWithKey(key, payload)),
    };
}
