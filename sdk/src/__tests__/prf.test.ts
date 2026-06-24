/**
 * Tests for WebAuthn PRF-derived client-side encryption.
 *
 * The PRF ceremony (navigator.credentials.get) is replaced with an injected
 * evaluator so the crypto path runs in Node without a browser/authenticator.
 * Node's WebCrypto provides the global `crypto.subtle` HKDF / AES-GCM used by
 * the module.
 */

import { webcrypto } from 'node:crypto'
import {
  createLocalCipher,
  deriveKeyFromPrf,
  encryptWithKey,
  decryptWithKey,
  isPrfSupported,
  FALLBACK_KEY_STORAGE,
  type PrfEvaluator,
  type PrfSecretStore,
} from '../crypto/prf'

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, writable: true, configurable: true })
})

// A deterministic PRF evaluator: the same credential always returns the same
// 32-byte output, mirroring a real authenticator's behaviour for a fixed salt.
function fixedEvaluator(seed: number): PrfEvaluator {
  return async () => new Uint8Array(32).fill(seed)
}

// In-memory storage adapter for the fallback path.
function memStore(): PrfSecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v) },
  }
}

describe('PRF key derivation', () => {
  it('derives a stable key for identical PRF output (same credential/session)', async () => {
    const cipherA = await createLocalCipher({ credentialId: 'cred', evaluator: fixedEvaluator(7) })
    const cipherB = await createLocalCipher({ credentialId: 'cred', evaluator: fixedEvaluator(7) })

    // Ciphertext from one "session" decrypts in the next — the hallmark of a
    // stable, deterministic key.
    const blob = await cipherA.encrypt('cached metadata')
    expect(await cipherB.decryptString(blob)).toBe('cached metadata')
    expect(cipherA.mode).toBe('prf')
  })

  it('produces a different key for a different PRF output', async () => {
    const k1 = await deriveKeyFromPrf(new Uint8Array(32).fill(1))
    const k2 = await deriveKeyFromPrf(new Uint8Array(32).fill(2))

    const ct = await encryptWithKey(k1, 'secret')
    await expect(decryptWithKey(k2, ct)).rejects.toThrow()
  })
})

describe('encrypt / decrypt round-trip', () => {
  it('round-trips strings and raw bytes', async () => {
    const cipher = await createLocalCipher({ credentialId: 'cred', evaluator: fixedEvaluator(3) })

    const str = await cipher.encrypt('hello passkey')
    expect(await cipher.decryptString(str)).toBe('hello passkey')

    const bytes = new Uint8Array([0, 1, 2, 250, 255])
    const enc = await cipher.encrypt(bytes)
    expect(Array.from(await cipher.decrypt(enc))).toEqual(Array.from(bytes))
  })

  it('emits non-deterministic ciphertext (fresh IV per call) yet decrypts', async () => {
    const cipher = await createLocalCipher({ credentialId: 'cred', evaluator: fixedEvaluator(9) })
    const a = await cipher.encrypt('same plaintext')
    const b = await cipher.encrypt('same plaintext')
    expect(a).not.toBe(b)
    expect(await cipher.decryptString(a)).toBe('same plaintext')
    expect(await cipher.decryptString(b)).toBe('same plaintext')
  })

  it('ciphertext is unreadable without the passkey-derived key', async () => {
    const owner = await createLocalCipher({ credentialId: 'cred', evaluator: fixedEvaluator(11) })
    const attacker = await createLocalCipher({ credentialId: 'cred', evaluator: fixedEvaluator(12) })

    const blob = await owner.encrypt('backup blob')
    await expect(attacker.decrypt(blob)).rejects.toThrow()
  })

  it('rejects a truncated/corrupt payload', async () => {
    const key = await deriveKeyFromPrf(new Uint8Array(32).fill(5))
    await expect(decryptWithKey(key, btoa('short'))).rejects.toThrow('Ciphertext too short')
  })
})

describe('feature detection + fallback', () => {
  it('isPrfSupported is false without WebAuthn globals', () => {
    expect(isPrfSupported()).toBe(false)
  })

  it('falls back to a persisted random key when PRF returns no result', async () => {
    const storage = memStore()
    const noPrf: PrfEvaluator = async () => null

    const cipher = await createLocalCipher({ credentialId: 'cred', storage, evaluator: noPrf })
    expect(cipher.mode).toBe('fallback')
    expect(storage.data.has(FALLBACK_KEY_STORAGE)).toBe(true)

    const blob = await cipher.encrypt('still works')
    expect(await cipher.decryptString(blob)).toBe('still works')
  })

  it('fallback key is stable across cipher instances (persisted)', async () => {
    const storage = memStore()
    const noPrf: PrfEvaluator = async () => null

    const first = await createLocalCipher({ credentialId: 'cred', storage, evaluator: noPrf })
    const blob = await first.encrypt('persist me')

    const second = await createLocalCipher({ credentialId: 'cred', storage, evaluator: noPrf })
    expect(await second.decryptString(blob)).toBe('persist me')
  })

  it('throws when PRF is unavailable and no storage is provided', async () => {
    const noPrf: PrfEvaluator = async () => null
    await expect(createLocalCipher({ credentialId: 'cred', evaluator: noPrf })).rejects.toThrow(
      /PRF is unavailable/,
    )
  })

  it('falls back when the PRF ceremony throws but storage exists', async () => {
    const storage = memStore()
    const throwing: PrfEvaluator = async () => { throw new Error('no prf extension') }
    const cipher = await createLocalCipher({ credentialId: 'cred', storage, evaluator: throwing })
    expect(cipher.mode).toBe('fallback')
  })
})
