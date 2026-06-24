/**
 * Encrypted cloud backup & cross-device restore.
 *
 * A user who loses their only device loses access to the wallet. This module
 * lets the client encrypt *non-secret* wallet metadata (address, signer set,
 * settings) with a user passphrase — or a PRF-derived key from a passkey — and
 * upload the ciphertext to a pluggable storage backend. On a new device the
 * blob is fetched, decrypted, and the wallet state reconstructed; a fresh
 * passkey is then enrolled and bound as a new signer.
 *
 * Security model:
 *   - Encryption is client-side (AES-256-GCM). The backend only ever sees the
 *     ciphertext envelope; it cannot read or forge the contents.
 *   - GCM is authenticated, so any tampering with the ciphertext, IV, or
 *     associated header is detected on decrypt and surfaced as a
 *     {@link BackupTamperError}.
 *   - Private key material is NEVER placed in a backup. {@link encryptBackup}
 *     refuses metadata that contains secret-looking fields.
 */

// ── Format constants ────────────────────────────────────────────────────────────

/** Bumped when the envelope or metadata layout changes incompatibly. */
export const BACKUP_FORMAT_VERSION = 1;

/** Default PBKDF2 work factor for passphrase-derived keys. */
export const DEFAULT_PBKDF2_ITERATIONS = 210_000;

// ── Types ───────────────────────────────────────────────────────────────────────

/** A wallet signer entry — only the public key is ever persisted. */
export type WalletSigner = {
    /** The signer's index in the wallet's on-chain signer list. */
    index: number;
    /** Hex-encoded uncompressed P-256 public key (65 bytes). */
    publicKey: string;
};

/**
 * The non-secret wallet state that is safe to back up. Deliberately excludes
 * any private key, mnemonic, or seed material.
 */
export type WalletBackupMetadata = {
    /** Metadata schema version. */
    version: number;
    /** The wallet's Soroban contract address ("C..."). */
    address: string;
    /** Public keys of the wallet's registered signers. */
    signers: WalletSigner[];
    /** Optional non-secret user settings (currency, theme, …). */
    settings?: Record<string, unknown>;
    /** Factory contract the wallet was deployed from, if known. */
    factoryAddress?: string;
    /** Stellar network passphrase the wallet lives on, if known. */
    networkPassphrase?: string;
    /** WebAuthn relying-party ID used to enrol passkeys. */
    rpId?: string;
    /** Unix timestamp (ms) the backup was created. */
    createdAt: number;
};

/**
 * The encrypted envelope handed to a storage backend. Every field is safe to
 * store in plaintext on the server — only {@link EncryptedBackup.ciphertext}
 * holds (encrypted) data, and it is authenticated.
 */
export type EncryptedBackup = {
    /** Envelope format version. */
    version: number;
    /** AEAD cipher used (currently always AES-GCM). */
    algorithm: 'AES-GCM';
    /** Key-derivation function: PBKDF2 for a passphrase, `none` for a raw key. */
    kdf: 'PBKDF2' | 'none';
    /** Base64 PBKDF2 salt (present only when kdf is PBKDF2). */
    salt?: string;
    /** PBKDF2 iteration count (present only when kdf is PBKDF2). */
    iterations?: number;
    /** Base64 AES-GCM initialisation vector (96-bit). */
    iv: string;
    /** Base64 ciphertext, with the GCM authentication tag appended. */
    ciphertext: string;
};

/**
 * The secret used to derive the AES key:
 *   - `string`     — a user passphrase, stretched with PBKDF2.
 *   - `Uint8Array` — a raw 32-byte key, e.g. derived from a passkey PRF
 *                    extension. Used directly with no KDF.
 */
export type BackupSecret = string | Uint8Array;

/**
 * Pluggable durable storage for backup blobs. Implement against any backend —
 * Supabase, S3, a KV store, or local storage. Only ciphertext is ever passed in.
 */
export interface BackupStorageBackend {
    /** Store (or overwrite) the ciphertext blob under `id`. */
    put(id: string, blob: string): Promise<void>;
    /** Fetch the ciphertext blob for `id`, or null if none exists. */
    get(id: string): Promise<string | null>;
    /** Optionally delete the blob for `id`. */
    remove?(id: string): Promise<void>;
}

// ── Errors ──────────────────────────────────────────────────────────────────────

/** Base class for all backup failures. */
export class BackupError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BackupError';
    }
}

/**
 * Thrown when a ciphertext fails authentication on decrypt — the wrong secret
 * was supplied, or the envelope was tampered with in transit/at rest.
 */
export class BackupTamperError extends BackupError {
    constructor(message = 'Backup failed authentication — wrong secret or tampered ciphertext') {
        super(message);
        this.name = 'BackupTamperError';
    }
}

// ── Secret-material guard ────────────────────────────────────────────────────────

// Field names that must never appear in a backup. Matched case-insensitively as
// substrings so `walletSecret`, `privateKeyHex`, `recoverySeed`, … are caught.
// Note: the Stellar *network* passphrase is public, so `passphrase` is not
// listed here — secret-bearing fields are named with the patterns below.
const FORBIDDEN_KEY_PATTERNS = [
    'privatekey',
    'secretkey',
    'secret',
    'mnemonic',
    'seed',
    'keypair',
];

/**
 * Recursively reject any object that carries secret-looking fields. This is the
 * last line of defence that keeps private key material out of cloud backups.
 *
 * @throws {BackupError} if a forbidden field is found.
 */
export function assertNoSecretMaterial(value: unknown, path = 'metadata'): void {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        value.forEach((item, i) => assertNoSecretMaterial(item, `${path}[${i}]`));
        return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
        if (FORBIDDEN_KEY_PATTERNS.some((p) => normalized.includes(p.replace(/[^a-z]/g, '')))) {
            throw new BackupError(
                `Refusing to back up secret material: field "${path}.${key}" is not allowed in a backup`
            );
        }
        assertNoSecretMaterial(child, `${path}.${key}`);
    }
}

// ── Encoding helpers ─────────────────────────────────────────────────────────────

function getCrypto(): Crypto {
    const c = (globalThis as { crypto?: Crypto }).crypto;
    if (!c || !c.subtle) {
        throw new BackupError(
            'Web Crypto (crypto.subtle) is unavailable. A secure context (HTTPS) or a ' +
            'crypto polyfill is required for encrypted backups.'
        );
    }
    return c;
}

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// ── Key derivation ───────────────────────────────────────────────────────────────

async function deriveAesKey(
    secret: BackupSecret,
    salt: Uint8Array | undefined,
    iterations: number,
): Promise<CryptoKey> {
    const subtle = getCrypto().subtle;

    if (typeof secret !== 'string') {
        // Raw key path (e.g. passkey PRF output). Must be exactly 32 bytes.
        if (secret.length !== 32) {
            throw new BackupError('A raw backup key must be exactly 32 bytes');
        }
        return subtle.importKey('raw', toArrayBuffer(secret), { name: 'AES-GCM' }, false, [
            'encrypt',
            'decrypt',
        ]);
    }

    if (!salt) throw new BackupError('A salt is required to derive a key from a passphrase');
    const baseKey = await subtle.importKey(
        'raw',
        toArrayBuffer(new TextEncoder().encode(secret)),
        { name: 'PBKDF2' },
        false,
        ['deriveKey'],
    );
    return subtle.deriveKey(
        { name: 'PBKDF2', salt: toArrayBuffer(salt), iterations, hash: 'SHA-256' },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

// ── Encrypt / decrypt ────────────────────────────────────────────────────────────

/**
 * Encrypt wallet metadata into an authenticated envelope. The metadata is first
 * screened for secret material (see {@link assertNoSecretMaterial}).
 *
 * @param metadata Non-secret wallet state to back up.
 * @param secret   A passphrase (PBKDF2) or a raw 32-byte key (e.g. passkey PRF).
 * @param opts     Optional PBKDF2 iteration override.
 */
export async function encryptBackup(
    metadata: WalletBackupMetadata,
    secret: BackupSecret,
    opts: { iterations?: number } = {},
): Promise<EncryptedBackup> {
    assertNoSecretMaterial(metadata);

    const crypto = getCrypto();
    const usePbkdf2 = typeof secret === 'string';
    const iterations = opts.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
    const salt = usePbkdf2 ? crypto.getRandomValues(new Uint8Array(16)) : undefined;
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const key = await deriveAesKey(secret, salt, iterations);
    const plaintext = new TextEncoder().encode(JSON.stringify(metadata));
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: toArrayBuffer(iv) },
        key,
        toArrayBuffer(plaintext),
    );

    return {
        version: BACKUP_FORMAT_VERSION,
        algorithm: 'AES-GCM',
        kdf: usePbkdf2 ? 'PBKDF2' : 'none',
        ...(salt ? { salt: toBase64(salt), iterations } : {}),
        iv: toBase64(iv),
        ciphertext: toBase64(new Uint8Array(ciphertext)),
    };
}

/**
 * Decrypt and validate a backup envelope.
 *
 * @throws {BackupTamperError} if authentication fails (wrong secret or tampering).
 * @throws {BackupError}       if the envelope is malformed or an unsupported version.
 */
export async function decryptBackup(
    encrypted: EncryptedBackup,
    secret: BackupSecret,
): Promise<WalletBackupMetadata> {
    if (!encrypted || typeof encrypted !== 'object') {
        throw new BackupError('Malformed backup envelope');
    }
    if (encrypted.version !== BACKUP_FORMAT_VERSION) {
        throw new BackupError(`Unsupported backup version: ${encrypted.version}`);
    }
    if (encrypted.algorithm !== 'AES-GCM') {
        throw new BackupError(`Unsupported backup algorithm: ${encrypted.algorithm}`);
    }

    const wantsPassphrase = encrypted.kdf === 'PBKDF2';
    if (wantsPassphrase !== (typeof secret === 'string')) {
        throw new BackupError(
            `Backup was sealed with kdf "${encrypted.kdf}" but the supplied secret does not match`
        );
    }

    const salt = encrypted.salt ? fromBase64(encrypted.salt) : undefined;
    const iv = fromBase64(encrypted.iv);
    const ciphertext = fromBase64(encrypted.ciphertext);
    const key = await deriveAesKey(secret, salt, encrypted.iterations ?? DEFAULT_PBKDF2_ITERATIONS);

    let plaintext: ArrayBuffer;
    try {
        plaintext = await getCrypto().subtle.decrypt(
            { name: 'AES-GCM', iv: toArrayBuffer(iv) },
            key,
            toArrayBuffer(ciphertext),
        );
    } catch {
        // AES-GCM throws an OperationError when the auth tag does not verify.
        throw new BackupTamperError();
    }

    let metadata: WalletBackupMetadata;
    try {
        metadata = JSON.parse(new TextDecoder().decode(plaintext)) as WalletBackupMetadata;
    } catch {
        throw new BackupTamperError('Decrypted backup is not valid JSON');
    }
    if (!metadata || typeof metadata.address !== 'string' || !Array.isArray(metadata.signers)) {
        throw new BackupTamperError('Decrypted backup is missing required fields');
    }
    return metadata;
}

// ── Serialisation ────────────────────────────────────────────────────────────────

/** Serialise an envelope to the compact JSON string stored by a backend. */
export function serializeBackup(encrypted: EncryptedBackup): string {
    return JSON.stringify(encrypted);
}

/** Parse a serialised envelope produced by {@link serializeBackup}. */
export function deserializeBackup(blob: string): EncryptedBackup {
    try {
        return JSON.parse(blob) as EncryptedBackup;
    } catch {
        throw new BackupError('Backup blob is not valid JSON');
    }
}

// ── Backup identifiers ───────────────────────────────────────────────────────────

/**
 * Derive a stable, non-secret backup id from the wallet address. Lets a new
 * device locate the blob knowing only the (public) wallet address. The address
 * is itself a SHA-256-derived contract id, so a plain hash is a fine bucket key.
 */
export async function deriveBackupId(address: string): Promise<string> {
    const digest = await getCrypto().subtle.digest('SHA-256', toArrayBuffer(new TextEncoder().encode(address)));
    return `backup_${toBase64(new Uint8Array(digest)).replace(/[+/=]/g, '').slice(0, 24)}`;
}

// ── Backend-driven create / restore ──────────────────────────────────────────────

/**
 * Encrypt and upload a wallet backup. Returns the storage id (derived from the
 * wallet address) and the envelope that was stored.
 */
export async function createBackup(
    metadata: WalletBackupMetadata,
    secret: BackupSecret,
    backend: BackupStorageBackend,
    opts: { id?: string; iterations?: number } = {},
): Promise<{ id: string; encrypted: EncryptedBackup }> {
    const encrypted = await encryptBackup(metadata, secret, { iterations: opts.iterations });
    const id = opts.id ?? (await deriveBackupId(metadata.address));
    await backend.put(id, serializeBackup(encrypted));
    return { id, encrypted };
}

/**
 * Fetch and decrypt a wallet backup from a backend.
 *
 * @throws {BackupError}       if no blob exists for `id`.
 * @throws {BackupTamperError} if the ciphertext fails authentication.
 */
export async function restoreBackup(
    id: string,
    secret: BackupSecret,
    backend: BackupStorageBackend,
): Promise<WalletBackupMetadata> {
    const blob = await backend.get(id);
    if (!blob) throw new BackupError(`No backup found for id "${id}"`);
    return decryptBackup(deserializeBackup(blob), secret);
}

/**
 * Reconstruct wallet state with a freshly enrolled signer bound in. Used on the
 * new device after restore: the device's new passkey public key is appended as
 * a signer (at the next free index) so it can authorise transactions once the
 * wallet adds it on-chain. Returns a new object; the input is not mutated.
 */
export function bindNewSigner(
    metadata: WalletBackupMetadata,
    newSignerPublicKeyHex: string,
): WalletBackupMetadata {
    if (!newSignerPublicKeyHex) throw new BackupError('A new signer public key is required');
    const alreadyBound = metadata.signers.some((s) => s.publicKey === newSignerPublicKeyHex);
    if (alreadyBound) return { ...metadata, signers: [...metadata.signers] };

    const nextIndex = metadata.signers.reduce((max, s) => Math.max(max, s.index), -1) + 1;
    return {
        ...metadata,
        signers: [...metadata.signers, { index: nextIndex, publicKey: newSignerPublicKeyHex }],
    };
}

// ── In-memory backend ────────────────────────────────────────────────────────────

/**
 * A simple in-memory {@link BackupStorageBackend}. Useful as a default, for
 * tests, and as a reference implementation. Not durable across reloads.
 */
export class MemoryBackupBackend implements BackupStorageBackend {
    private store = new Map<string, string>();

    async put(id: string, blob: string): Promise<void> {
        this.store.set(id, blob);
    }

    async get(id: string): Promise<string | null> {
        return this.store.has(id) ? this.store.get(id)! : null;
    }

    async remove(id: string): Promise<void> {
        this.store.delete(id);
    }
}
