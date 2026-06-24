/**
 * Tests for the wallet-level encrypted backup wiring (lib/backup.ts).
 *
 * Exercises a full round-trip through a pluggable backend, confirms the backend
 * only ever holds ciphertext, verifies tamper detection, and checks that restore
 * reconstructs local wallet state and enrols + binds a new signer passkey.
 *
 * jsdom lacks crypto.subtle, so we install Node's real Web Crypto first.
 */

import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
})
// jsdom does not provide these globals; the SDK backup code needs them.
Object.assign(globalThis, { TextEncoder, TextDecoder })

import {
  backupWallet,
  restoreWallet,
  collectWalletMetadata,
  persistRestoredState,
  LocalStorageBackupBackend,
  createSupabaseBackupBackend,
} from '../backup'
import { MemoryBackupBackend, BackupTamperError, deserializeBackup } from '@veil/backup'

// ── localStorage shim ─────────────────────────────────────────────────────────

const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v) },
    removeItem: (k: string) => { delete store[k] },
    clear: () => { store = {} },
  }
})()

/** Build a registration credential exposing a real P-256 SPKI, so the wallet's
 *  public-key extraction runs for real during re-bind. */
async function makeRealRegistrationCredential(id: string) {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const spki = await webcrypto.subtle.exportKey('spki', pair.publicKey)
  return {
    id,
    type: 'public-key',
    response: { getPublicKey: () => spki },
  }
}

const ADDRESS = 'CWALLETADDRESS1234567890'
const PRIMARY_PUBLIC_KEY = 'aa'.repeat(65)

function seedWallet() {
  localStorageMock.setItem('invisible_wallet_address', ADDRESS)
  localStorageMock.setItem('invisible_wallet_public_key', PRIMARY_PUBLIC_KEY)
  localStorageMock.setItem('veil_wallet_settings', JSON.stringify({ currency: 'USD' }))
}

const mockCredentialsCreate = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  localStorageMock.clear()

  Object.defineProperty(global, 'localStorage', { value: localStorageMock, writable: true, configurable: true })
  Object.defineProperty(global, 'navigator', {
    value: { credentials: { create: mockCredentialsCreate } },
    writable: true,
    configurable: true,
  })
})

// ── collectWalletMetadata ─────────────────────────────────────────────────────

describe('collectWalletMetadata', () => {
  it('reads non-secret wallet state from local storage', () => {
    seedWallet()
    const md = collectWalletMetadata()
    expect(md.address).toBe(ADDRESS)
    expect(md.signers).toEqual([{ index: 0, publicKey: PRIMARY_PUBLIC_KEY }])
    expect(md.settings).toEqual({ currency: 'USD' })
  })

  it('throws when no wallet is present', () => {
    expect(() => collectWalletMetadata()).toThrow(/No wallet found/)
  })

  it('never includes private key material', () => {
    seedWallet()
    localStorageMock.setItem('invisible_wallet_recovery_private_key', 'deadbeef')
    const md = collectWalletMetadata()
    expect(JSON.stringify(md)).not.toContain('deadbeef')
  })
})

// ── round-trip ────────────────────────────────────────────────────────────────

describe('backupWallet / restoreWallet round-trip', () => {
  it('backs up and restores wallet state through a backend', async () => {
    seedWallet()
    const backend = new MemoryBackupBackend()

    const { id } = await backupWallet('hunter2', { backend })
    localStorageMock.clear() // simulate a fresh device

    const { metadata } = await restoreWallet('hunter2', { backend, address: ADDRESS, rebind: false })

    expect(metadata.address).toBe(ADDRESS)
    expect(metadata.settings).toEqual({ currency: 'USD' })
    // Local state rehydrated on the new device.
    expect(localStorageMock.getItem('invisible_wallet_address')).toBe(ADDRESS)
    expect(id).toMatch(/^backup_/)
  })

  it('keeps only ciphertext in the backend — no plaintext leaks', async () => {
    seedWallet()
    const backend = new MemoryBackupBackend()
    const { id } = await backupWallet('hunter2', { backend })

    const blob = await backend.get(id)
    expect(blob).not.toBeNull()
    expect(blob!).not.toContain(ADDRESS)
    expect(blob!).not.toContain('USD')
    const env = deserializeBackup(blob!)
    expect(env.algorithm).toBe('AES-GCM')
    expect(env.kdf).toBe('PBKDF2')
  })

  it('restores and binds a freshly enrolled passkey as a new signer', async () => {
    seedWallet()
    const backend = new MemoryBackupBackend()
    await backupWallet('hunter2', { backend })
    localStorageMock.clear()

    mockCredentialsCreate.mockResolvedValueOnce(await makeRealRegistrationCredential('bmV3LWRldmljZS1jcmVk'))

    const { metadata, newSigner } = await restoreWallet('hunter2', { backend, address: ADDRESS })

    expect(mockCredentialsCreate).toHaveBeenCalledTimes(1)
    expect(newSigner).toBeDefined()
    expect(newSigner!.credentialId).toBe('bmV3LWRldmljZS1jcmVk')
    expect(newSigner!.publicKey).toHaveLength(130) // 65 bytes hex
    // The new device's signer is bound into the restored state…
    expect(metadata.signers.map((s) => s.publicKey)).toContain(newSigner!.publicKey)
    expect(metadata.signers).toHaveLength(2)
    // …and persisted locally so the device can authenticate.
    expect(localStorageMock.getItem('invisible_wallet_key_id')).toBe('bmV3LWRldmljZS1jcmVk')
  })
})

// ── tamper detection ──────────────────────────────────────────────────────────

describe('tamper detection', () => {
  it('rejects a wrong passphrase on restore', async () => {
    seedWallet()
    const backend = new MemoryBackupBackend()
    await backupWallet('right-pass', { backend })
    await expect(
      restoreWallet('wrong-pass', { backend, address: ADDRESS, rebind: false }),
    ).rejects.toBeInstanceOf(BackupTamperError)
  })

  it('rejects a tampered ciphertext on restore', async () => {
    seedWallet()
    const backend = new MemoryBackupBackend()
    const { id } = await backupWallet('right-pass', { backend })

    const blob = await backend.get(id)
    const env = deserializeBackup(blob!)
    const bytes = Buffer.from(env.ciphertext, 'base64')
    bytes[0] ^= 0xff
    await backend.put(id, JSON.stringify({ ...env, ciphertext: bytes.toString('base64') }))

    await expect(
      restoreWallet('right-pass', { backend, address: ADDRESS, rebind: false }),
    ).rejects.toBeInstanceOf(BackupTamperError)
  })
})

// ── backends ──────────────────────────────────────────────────────────────────

describe('LocalStorageBackupBackend', () => {
  it('stores and reads blobs under a namespaced key', async () => {
    const backend = new LocalStorageBackupBackend()
    await backend.put('abc', 'ciphertext')
    expect(localStorageMock.getItem('veil_backup_abc')).toBe('ciphertext')
    expect(await backend.get('abc')).toBe('ciphertext')
    await backend.remove('abc')
    expect(await backend.get('abc')).toBeNull()
  })
})

describe('createSupabaseBackupBackend', () => {
  it('upserts ciphertext and reads it back', async () => {
    const rows: Record<string, string> = {}
    const client = {
      from: () => ({
        upsert: async ({ id, ciphertext }: { id: string; ciphertext: string }) => {
          rows[id] = ciphertext
          return { error: null }
        },
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { ciphertext: rows['k1'] ?? null }, error: null }),
          }),
        }),
      }),
    }
    const backend = createSupabaseBackupBackend(client as any)
    await backend.put('k1', 'cipher')
    expect(rows['k1']).toBe('cipher')
    expect(await backend.get('k1')).toBe('cipher')
  })
})
