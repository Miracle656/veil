/**
 * Tests for encrypted cloud backup & cross-device restore.
 *
 * Uses Node's real Web Crypto (webcrypto) so AES-GCM authentication — and thus
 * tamper detection — is exercised end to end. jsdom does not provide
 * crypto.subtle, so we install it here before the module under test runs.
 */

import { webcrypto } from 'crypto'

// Provide a real crypto.subtle to the module under test (jsdom lacks it).
Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
})

import {
  encryptBackup,
  decryptBackup,
  serializeBackup,
  deserializeBackup,
  createBackup,
  restoreBackup,
  bindNewSigner,
  deriveBackupId,
  assertNoSecretMaterial,
  MemoryBackupBackend,
  BackupError,
  BackupTamperError,
  BACKUP_FORMAT_VERSION,
  type WalletBackupMetadata,
} from '../backup'

function sampleMetadata(): WalletBackupMetadata {
  return {
    version: BACKUP_FORMAT_VERSION,
    address: 'CWALLETADDRESS1234567890',
    signers: [{ index: 0, publicKey: 'aa'.repeat(65) }],
    settings: { currency: 'USD', theme: 'dark' },
    factoryAddress: 'CFACTORY',
    networkPassphrase: 'Test SDF Network ; September 2015',
    rpId: 'veil.app',
    createdAt: 1_700_000_000_000,
  }
}

describe('encryptBackup / decryptBackup', () => {
  it('round-trips metadata with a passphrase', async () => {
    const metadata = sampleMetadata()
    const sealed = await encryptBackup(metadata, 'correct horse battery staple')
    const restored = await decryptBackup(sealed, 'correct horse battery staple')
    expect(restored).toEqual(metadata)
  })

  it('round-trips metadata with a raw PRF-derived 32-byte key', async () => {
    const metadata = sampleMetadata()
    const key = webcrypto.getRandomValues(new Uint8Array(32))
    const sealed = await encryptBackup(metadata, key)
    expect(sealed.kdf).toBe('none')
    const restored = await decryptBackup(sealed, key)
    expect(restored).toEqual(metadata)
  })

  it('produces an envelope that exposes no plaintext to the server', async () => {
    const metadata = sampleMetadata()
    const sealed = await encryptBackup(metadata, 'pw')
    const blob = serializeBackup(sealed)
    expect(blob).not.toContain('CWALLETADDRESS1234567890')
    expect(blob).not.toContain('USD')
    expect(sealed.algorithm).toBe('AES-GCM')
    expect(sealed.kdf).toBe('PBKDF2')
    expect(typeof sealed.salt).toBe('string')
    expect(typeof sealed.iv).toBe('string')
  })

  it('uses a fresh salt and IV on every call', async () => {
    const metadata = sampleMetadata()
    const a = await encryptBackup(metadata, 'pw')
    const b = await encryptBackup(metadata, 'pw')
    expect(a.salt).not.toEqual(b.salt)
    expect(a.iv).not.toEqual(b.iv)
    expect(a.ciphertext).not.toEqual(b.ciphertext)
  })

  it('rejects raw keys that are not 32 bytes', async () => {
    await expect(encryptBackup(sampleMetadata(), new Uint8Array(16))).rejects.toThrow(BackupError)
  })
})

describe('tamper detection', () => {
  it('throws BackupTamperError on the wrong passphrase', async () => {
    const sealed = await encryptBackup(sampleMetadata(), 'right')
    await expect(decryptBackup(sealed, 'wrong')).rejects.toBeInstanceOf(BackupTamperError)
  })

  it('throws BackupTamperError when the ciphertext is mutated', async () => {
    const sealed = await encryptBackup(sampleMetadata(), 'pw')
    const bytes = Buffer.from(sealed.ciphertext, 'base64')
    bytes[0] ^= 0xff // flip a bit
    const tampered = { ...sealed, ciphertext: bytes.toString('base64') }
    await expect(decryptBackup(tampered, 'pw')).rejects.toBeInstanceOf(BackupTamperError)
  })

  it('throws BackupTamperError when the IV is mutated', async () => {
    const sealed = await encryptBackup(sampleMetadata(), 'pw')
    const iv = Buffer.from(sealed.iv, 'base64')
    iv[0] ^= 0x01
    const tampered = { ...sealed, iv: iv.toString('base64') }
    await expect(decryptBackup(tampered, 'pw')).rejects.toBeInstanceOf(BackupTamperError)
  })

  it('rejects an unsupported envelope version', async () => {
    const sealed = await encryptBackup(sampleMetadata(), 'pw')
    await expect(decryptBackup({ ...sealed, version: 99 }, 'pw')).rejects.toThrow(BackupError)
  })

  it('rejects a secret type that does not match the envelope kdf', async () => {
    const sealed = await encryptBackup(sampleMetadata(), 'pw')
    const key = webcrypto.getRandomValues(new Uint8Array(32))
    await expect(decryptBackup(sealed, key)).rejects.toThrow(BackupError)
  })
})

describe('assertNoSecretMaterial', () => {
  it('passes for clean metadata', () => {
    expect(() => assertNoSecretMaterial(sampleMetadata())).not.toThrow()
  })

  it.each([
    { privateKey: 'deadbeef' },
    { settings: { nested: { mnemonic: 'a b c' } } },
    { recoverySeed: 'x' },
    { signerSecretKey: 'y' },
  ])('rejects metadata carrying secret material (%o)', (bad) => {
    expect(() => assertNoSecretMaterial({ ...sampleMetadata(), ...bad })).toThrow(BackupError)
  })

  it('blocks encryption of metadata with secret material', async () => {
    const bad = { ...sampleMetadata(), privateKey: 'deadbeef' } as unknown as WalletBackupMetadata
    await expect(encryptBackup(bad, 'pw')).rejects.toThrow(/secret material/)
  })
})

describe('backend create / restore', () => {
  it('round-trips through a pluggable backend keyed by wallet address', async () => {
    const backend = new MemoryBackupBackend()
    const metadata = sampleMetadata()

    const { id } = await createBackup(metadata, 'pw', backend)
    expect(id).toBe(await deriveBackupId(metadata.address))

    // The backend only ever holds ciphertext.
    const stored = await backend.get(id)
    expect(stored).not.toBeNull()
    expect(stored!).not.toContain(metadata.address)

    const restored = await restoreBackup(id, 'pw', backend)
    expect(restored).toEqual(metadata)
  })

  it('throws when restoring an id with no stored backup', async () => {
    const backend = new MemoryBackupBackend()
    await expect(restoreBackup('missing', 'pw', backend)).rejects.toThrow(BackupError)
  })

  it('deserializeBackup rejects malformed blobs', () => {
    expect(() => deserializeBackup('{not json')).toThrow(BackupError)
  })
})

describe('bindNewSigner', () => {
  it('appends the new device signer at the next free index without mutating input', () => {
    const metadata = sampleMetadata()
    const bound = bindNewSigner(metadata, 'bb'.repeat(65))

    expect(metadata.signers).toHaveLength(1) // input untouched
    expect(bound.signers).toHaveLength(2)
    expect(bound.signers[1]).toEqual({ index: 1, publicKey: 'bb'.repeat(65) })
  })

  it('is idempotent for an already-bound signer', () => {
    const metadata = sampleMetadata()
    const bound = bindNewSigner(metadata, metadata.signers[0].publicKey)
    expect(bound.signers).toHaveLength(1)
  })

  it('reconstructs full wallet state and binds a signer end to end', async () => {
    const backend = new MemoryBackupBackend()
    const original = sampleMetadata()
    const { id } = await createBackup(original, 'pw', backend)

    // New device: restore, then bind its freshly enrolled passkey.
    const restored = await restoreBackup(id, 'pw', backend)
    const newDeviceKey = 'cc'.repeat(65)
    const rebound = bindNewSigner(restored, newDeviceKey)

    expect(rebound.address).toBe(original.address)
    expect(rebound.signers.map((s) => s.publicKey)).toContain(newDeviceKey)
  })
})
