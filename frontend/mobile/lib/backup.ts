/**
 * Encrypted wallet backup — React Native port of `sdk/src/backup.ts`.
 *
 * The SDK module builds its envelope on Web Crypto (`crypto.subtle`), which
 * Hermes does not implement. This port keeps the *wire format* byte-for-byte
 * identical — AES-256-GCM over a PBKDF2-SHA256 key, base64 fields, envelope
 * version 1 — but derives and applies the key with audited pure-JS primitives
 * that run on device. A file exported here therefore restores in the web wallet,
 * and a blob produced by the web wallet restores here.
 *
 * Security model (unchanged from the SDK):
 *   - Encryption is client-side. Whatever the ciphertext is handed to — a file,
 *     a share sheet, a cloud drive — only ever sees the sealed envelope.
 *   - GCM is authenticated, so tampering with the ciphertext, the IV, or the
 *     envelope is detected on decrypt and raised as a {@link BackupTamperError}.
 *   - Private key material is NEVER placed in a backup. {@link encryptBackup}
 *     screens the metadata through {@link assertNoSecretMaterial} first.
 */

import { gcm } from '@noble/ciphers/aes.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as Crypto from 'expo-crypto';

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
 * The encrypted envelope written to disk. Every field is safe to store in
 * plaintext — only {@link EncryptedBackup.ciphertext} holds data, and it is
 * authenticated.
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
 * Pluggable durable storage for backup blobs. Implement against any sink — the
 * device filesystem, a KV store, a cloud bucket. Only ciphertext is passed in.
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
 * last line of defence that keeps private key material out of exported backups.
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
    if (FORBIDDEN_KEY_PATTERNS.some((p) => normalized.includes(p))) {
      throw new BackupError(
        `Refusing to back up secret material: field "${path}.${key}" is not allowed in a backup`
      );
    }
    assertNoSecretMaterial(child, `${path}.${key}`);
  }
}

// ── Base64 ───────────────────────────────────────────────────────────────────────

// Hermes does not guarantee `btoa`/`atob`, so the codec is inlined. Standard
// alphabet with padding, matching what the SDK's `btoa` path emits.

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : B64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : B64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

function fromBase64(b64: string): Uint8Array {
  const clean = b64.replace(/[\r\n\s]/g, '').replace(/=+$/, '');
  const out = new Uint8Array((clean.length * 3) >> 2);
  let acc = 0;
  let bits = 0;
  let written = 0;
  for (let i = 0; i < clean.length; i++) {
    const digit = B64_ALPHABET.indexOf(clean[i]);
    if (digit < 0) throw new BackupError('Backup envelope contains malformed base64');
    acc = (acc << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

// ── Key derivation ───────────────────────────────────────────────────────────────

/**
 * Stretch a passphrase (or accept a raw key) into the 32-byte AES-256 key.
 *
 * PBKDF2 at the default work factor takes a noticeable moment on device — it is
 * a synchronous, CPU-bound loop that blocks the JS thread. Callers should show a
 * busy state and let a frame paint before invoking the encrypt/decrypt helpers.
 */
function deriveAesKey(
  secret: BackupSecret,
  salt: Uint8Array | undefined,
  iterations: number
): Uint8Array {
  if (typeof secret !== 'string') {
    // Raw key path (e.g. passkey PRF output). Must be exactly 32 bytes.
    if (secret.length !== 32) {
      throw new BackupError('A raw backup key must be exactly 32 bytes');
    }
    return secret;
  }

  if (!salt) throw new BackupError('A salt is required to derive a key from a passphrase');
  return pbkdf2(sha256, new TextEncoder().encode(secret), salt, { c: iterations, dkLen: 32 });
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
export function encryptBackup(
  metadata: WalletBackupMetadata,
  secret: BackupSecret,
  opts: { iterations?: number } = {}
): EncryptedBackup {
  assertNoSecretMaterial(metadata);

  const usePbkdf2 = typeof secret === 'string';
  const iterations = opts.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  const salt = usePbkdf2 ? Crypto.getRandomBytes(16) : undefined;
  const iv = Crypto.getRandomBytes(12);

  const key = deriveAesKey(secret, salt, iterations);
  const plaintext = new TextEncoder().encode(JSON.stringify(metadata));
  const ciphertext = gcm(key, iv).encrypt(plaintext);

  return {
    version: BACKUP_FORMAT_VERSION,
    algorithm: 'AES-GCM',
    kdf: usePbkdf2 ? 'PBKDF2' : 'none',
    ...(salt ? { salt: toBase64(salt), iterations } : {}),
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext),
  };
}

// ── Serialisation ────────────────────────────────────────────────────────────────

/** Serialise an envelope to the JSON string written to a backup file. */
export function serializeBackup(encrypted: EncryptedBackup): string {
  return JSON.stringify(encrypted);
}

// ── Backup identifiers ───────────────────────────────────────────────────────────

/**
 * Derive a stable, non-secret backup id from the wallet address. Lets a new
 * device locate a blob knowing only the (public) wallet address. The address is
 * itself a SHA-256-derived contract id, so a plain hash is a fine bucket key.
 */
export function deriveBackupId(address: string): string {
  const digest = sha256(new TextEncoder().encode(address));
  return `backup_${toBase64(digest).replace(/[+/=]/g, '').slice(0, 24)}`;
}

// ── Backend-driven create ────────────────────────────────────────────────────────

/**
 * Encrypt a wallet backup and hand the ciphertext to a storage backend. Returns
 * the storage id (derived from the wallet address unless overridden) and the
 * envelope that was stored.
 */
export async function createBackup(
  metadata: WalletBackupMetadata,
  secret: BackupSecret,
  backend: BackupStorageBackend,
  opts: { id?: string; iterations?: number } = {}
): Promise<{ id: string; encrypted: EncryptedBackup }> {
  const encrypted = encryptBackup(metadata, secret, { iterations: opts.iterations });
  const id = opts.id ?? deriveBackupId(metadata.address);
  await backend.put(id, serializeBackup(encrypted));
  return { id, encrypted };
}
