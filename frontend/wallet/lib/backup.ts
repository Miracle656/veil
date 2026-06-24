/**
 * Encrypted cloud backup & cross-device restore — wallet wiring.
 *
 * This module connects the framework-agnostic backup primitives in the SDK
 * (`@veil/backup`) to the wallet's local storage, a pluggable cloud backend, and
 * passkey enrolment. The flow:
 *
 *   Backup  — read the wallet's non-secret metadata from local storage, encrypt
 *             it client-side, and upload the ciphertext.
 *   Restore — on a new device, fetch + decrypt the blob, write the wallet state
 *             back to local storage, enrol a fresh passkey, and bind it as a new
 *             signer (the on-chain `add_signer` call is left to the caller).
 *
 * No private key material is ever read into a backup — the SDK guards against it.
 */

import {
  createBackup,
  restoreBackup,
  bindNewSigner,
  deriveBackupId,
  serializeBackup,
  deserializeBackup,
  type WalletBackupMetadata,
  type EncryptedBackup,
  type BackupSecret,
  type BackupStorageBackend,
} from '@veil/backup'

// Local crypto helpers — kept inline so the backup path stays free of the heavy
// @stellar/stellar-sdk dependency that `@veil/utils` pulls in.

function bufferToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Extract the 65-byte uncompressed P-256 public key from a WebAuthn response. */
async function extractP256PublicKey(response: AuthenticatorAttestationResponse): Promise<Uint8Array> {
  const spki = response.getPublicKey()
  if (!spki) {
    throw new Error('getPublicKey() returned null — the authenticator or browser is unsupported')
  }
  const cryptoKey = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
  return new Uint8Array(await crypto.subtle.exportKey('raw', cryptoKey))
}

// Wallet credential keys written by the SDK (`useInvisibleWallet`).
const ADDRESS_KEY = 'invisible_wallet_address'
const KEY_ID_KEY = 'invisible_wallet_key_id'
const PUBLIC_KEY_KEY = 'invisible_wallet_public_key'
const SETTINGS_KEY = 'veil_wallet_settings'

const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015'

// ── Pluggable backends ───────────────────────────────────────────────────────────

/**
 * A {@link BackupStorageBackend} backed by `localStorage`. Handy as a default and
 * for development; a real deployment swaps in a cloud backend (see
 * {@link createSupabaseBackupBackend}). Only ciphertext is stored.
 */
export class LocalStorageBackupBackend implements BackupStorageBackend {
  constructor(private prefix = 'veil_backup_') {}

  async put(id: string, blob: string): Promise<void> {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(this.prefix + id, blob)
  }

  async get(id: string): Promise<string | null> {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(this.prefix + id)
  }

  async remove(id: string): Promise<void> {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem(this.prefix + id)
  }
}

/**
 * Build a cloud {@link BackupStorageBackend} over a Supabase table. The table is
 * expected to expose `id` (text, primary key) and `ciphertext` (text) columns.
 * The server only ever sees the encrypted envelope.
 *
 * @param client A `@supabase/supabase-js` client.
 * @param table  Table name (defaults to `wallet_backups`).
 */
export function createSupabaseBackupBackend(
  client: { from: (table: string) => any },
  table = 'wallet_backups',
): BackupStorageBackend {
  return {
    async put(id, blob) {
      const { error } = await client.from(table).upsert({ id, ciphertext: blob })
      if (error) throw new Error(`Backup upload failed: ${error.message ?? String(error)}`)
    },
    async get(id) {
      const { data, error } = await client.from(table).select('ciphertext').eq('id', id).maybeSingle()
      if (error) throw new Error(`Backup fetch failed: ${error.message ?? String(error)}`)
      return data?.ciphertext ?? null
    },
    async remove(id) {
      await client.from(table).delete().eq('id', id)
    },
  }
}

// ── Local wallet state <-> metadata ──────────────────────────────────────────────

function readSettings(): Record<string, unknown> | undefined {
  if (typeof localStorage === 'undefined') return undefined
  const raw = localStorage.getItem(SETTINGS_KEY)
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * Read the wallet's non-secret state from local storage into a backup metadata
 * object. Throws if no wallet is present on this device.
 *
 * @param overrides Optional extra fields (e.g. the full on-chain signer set, or
 *                  the factory/network the wallet lives on) merged into the result.
 */
export function collectWalletMetadata(overrides: Partial<WalletBackupMetadata> = {}): WalletBackupMetadata {
  if (typeof localStorage === 'undefined') {
    throw new Error('collectWalletMetadata must run in a browser context')
  }
  const address = overrides.address ?? localStorage.getItem(ADDRESS_KEY) ?? ''
  const publicKey = localStorage.getItem(PUBLIC_KEY_KEY)
  if (!address) throw new Error('No wallet found on this device. Register before backing up.')

  const signers =
    overrides.signers ??
    (publicKey ? [{ index: 0, publicKey }] : [])

  return {
    version: 1,
    address,
    signers,
    settings: overrides.settings ?? readSettings(),
    factoryAddress: overrides.factoryAddress,
    networkPassphrase: overrides.networkPassphrase ?? TESTNET_PASSPHRASE,
    rpId: overrides.rpId ?? (typeof window !== 'undefined' ? window.location.hostname : undefined),
    createdAt: overrides.createdAt ?? Date.now(),
  }
}

/** Write the non-secret parts of a restored backup back into local storage. */
export function persistRestoredState(metadata: WalletBackupMetadata): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(ADDRESS_KEY, metadata.address)
  const primary = metadata.signers[0]?.publicKey
  if (primary) localStorage.setItem(PUBLIC_KEY_KEY, primary)
  if (metadata.settings) localStorage.setItem(SETTINGS_KEY, JSON.stringify(metadata.settings))
}

// ── Backup ───────────────────────────────────────────────────────────────────────

export type BackupResult = {
  /** Storage id the ciphertext was written under. */
  id: string
  /** The encrypted envelope that was uploaded. */
  encrypted: EncryptedBackup
}

/**
 * Encrypt this device's wallet metadata and upload it to a backend.
 *
 * @param secret A user passphrase, or a raw 32-byte PRF-derived key.
 * @param opts   Backend (defaults to local storage), metadata overrides, and
 *               PBKDF2 iteration override.
 */
export async function backupWallet(
  secret: BackupSecret,
  opts: {
    backend?: BackupStorageBackend
    metadata?: Partial<WalletBackupMetadata>
    iterations?: number
  } = {},
): Promise<BackupResult> {
  const backend = opts.backend ?? new LocalStorageBackupBackend()
  const metadata = collectWalletMetadata(opts.metadata)
  return createBackup(metadata, secret, backend, { iterations: opts.iterations })
}

// ── Restore + re-bind ─────────────────────────────────────────────────────────────

export type RestoreResult = {
  /** The decrypted wallet metadata, with the new signer bound in (when enrolled). */
  metadata: WalletBackupMetadata
  /**
   * The freshly enrolled passkey for this device, when `rebind` was not disabled.
   * The caller must add `publicKey` as an on-chain signer (via the SDK's
   * `addSigner`) to finish binding the new device.
   */
  newSigner?: { publicKey: string; credentialId: string }
}

/**
 * Restore a wallet on a new device: fetch + decrypt the backup, write the wallet
 * state to local storage, and (unless disabled) enrol a new passkey and bind it
 * as a signer.
 *
 * Locate the blob with either an explicit `backupId` or the (public) wallet
 * `address`, from which the id is derived.
 */
export async function restoreWallet(
  secret: BackupSecret,
  opts: {
    backend?: BackupStorageBackend
    address?: string
    backupId?: string
    rebind?: boolean
    rpId?: string
    userName?: string
  },
): Promise<RestoreResult> {
  const backend = opts.backend ?? new LocalStorageBackupBackend()

  let id = opts.backupId
  if (!id) {
    if (!opts.address) throw new Error('Provide an address or backupId to locate the backup')
    id = await deriveBackupId(opts.address)
  }

  const metadata = await restoreBackup(id, secret, backend)
  persistRestoredState(metadata)

  if (opts.rebind === false) return { metadata }
  if (typeof navigator === 'undefined' || !navigator.credentials) {
    // No WebAuthn here (e.g. SSR) — return the restored state without re-binding.
    return { metadata }
  }

  const newSigner = await enrollNewSignerPasskey({
    rpId: opts.rpId ?? metadata.rpId,
    userName: opts.userName,
  })

  return {
    metadata: bindNewSigner(metadata, newSigner.publicKey),
    newSigner,
  }
}

/**
 * Enrol a fresh passkey on the current device and persist its credential id and
 * public key locally. Returns the hex public key (to be added on-chain as a
 * signer) and the base64url credential id.
 */
export async function enrollNewSignerPasskey(
  opts: { rpId?: string; userName?: string } = {},
): Promise<{ publicKey: string; credentialId: string }> {
  const rpId = opts.rpId ?? (typeof window !== 'undefined' ? window.location.hostname : 'localhost')
  const userName = opts.userName ?? 'Veil User'
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const userId = crypto.getRandomValues(new Uint8Array(16))

  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { id: rpId, name: 'Invisible Wallet' },
      user: { id: userId, name: userName, displayName: userName },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: 60_000,
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    },
  })) as PublicKeyCredential | null

  if (!credential) throw new Error('Passkey enrolment was cancelled')

  const response = credential.response as AuthenticatorAttestationResponse
  const publicKeyBytes = await extractP256PublicKey(response)
  const publicKey = bufferToHex(publicKeyBytes)

  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(KEY_ID_KEY, credential.id)
    localStorage.setItem(PUBLIC_KEY_KEY, publicKey)
  }

  return { publicKey, credentialId: credential.id }
}

// Re-export the serialisation helpers so callers can move blobs around (e.g.
// export to a file) without importing from the SDK directly.
export { serializeBackup, deserializeBackup }
export type { WalletBackupMetadata, EncryptedBackup, BackupSecret, BackupStorageBackend }
