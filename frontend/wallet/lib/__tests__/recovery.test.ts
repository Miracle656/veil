/**
 * @jest-environment node
 *
 * Runs under Node (not jsdom) so Web Crypto sees same-realm ArrayBuffers —
 * jsdom's separate realm makes the PBKDF2 `salt` fail SubtleCrypto's
 * `instanceof ArrayBuffer` check (see backup.test.ts).
 *
 * Tests for lib/recovery.ts: the paper-phrase recovery key, the encrypted
 * on-device backup of that phrase, the WebAuthn emulation that lets the
 * recovered key sign, and the SEP-30 server-assisted path.
 *
 * Recovery is only ever exercised on the day someone has lost their device, so
 * a bug here is found when it can no longer be fixed. The refusals come first:
 * a recovery that wrongly succeeds hands someone the wrong wallet.
 *
 * What is real: BIP-39, P-256, SHA-256, PBKDF2 and AES-GCM (Node's WebCrypto),
 * and the SDK's SEP-30 client. What is faked: IndexedDB (an in-memory store
 * with the same request/transaction shape), localStorage, and `fetch` (each
 * recovery server is a route table, so what the client sent is recorded).
 *
 * No key material is printed. Mnemonics below are the published BIP-39 test
 * vectors or freshly generated ones; private keys are never interpolated into
 * an assertion message, and the tests that inspect error text assert that no
 * secret appears in it.
 *
 * The interceptor that patches navigator.credentials.get needs a DOM and lives
 * in recoveryInterceptor.test.ts.
 */

import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
  writable: true,
})
Object.assign(globalThis, { TextEncoder, TextDecoder })

// Real PBKDF2 at 100,000 iterations, several times per test.
jest.setTimeout(30_000)

import * as bip39 from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { p256 } from '@noble/curves/nist'
import { sha256 } from '@noble/hashes/sha256'
import { bufferToHex, derToRawSignature } from '@veil/utils'
import { Sep30Error } from '@veil/recovery'
import { Keypair, StrKey } from '@stellar/stellar-sdk'
import {
  generateMnemonicPhrase,
  deriveP256KeyPair,
  signWithP256,
  encryptMnemonic,
  decryptMnemonic,
  storeEncryptedMnemonic,
  getEncryptedMnemonic,
  base64url,
  rawToDerSignature,
  generateRecoveryWebAuthnSignature,
  initRecoveryInterceptor,
  buildRecoveryClients,
  rememberRecoveryServers,
  getRememberedRecoveryServers,
  registerWithRecoveryServers,
  resolveRecoveryServers,
  recoverSignatures,
} from '../recovery'

// The published BIP-39 test vector (trezor/python-mnemonic vectors.json, first
// entry). Its seed with an empty passphrase is fixed by the standard.
const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const VECTOR_SEED_HEX =
  '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4'
// The recovery signer that phrase registers on a wallet contract: the 65-byte
// uncompressed P-256 point for sha256(seed). Pinned so a change to the
// derivation cannot pass unnoticed — every paper backup ever written resolves
// to its signer through this exact function.
const VECTOR_PUBLIC_KEY_HEX =
  '0458dbd787ce6ce717c3718f95ebd527c97d2b6e7cbde02c034b1cf5882a18f2fb01a758365a3c8292052ce7aef59745a7f6996c0659c8d5f5c61ea88ab238906b'

/** Another valid phrase: the second published BIP-39 12-word vector. */
const NEIGHBOUR_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow'

/**
 * The comparison the recover page makes (app/recover/page.tsx,
 * handlePaperRecover): a phrase recovers a wallet only when the key it derives
 * is one of that wallet's on-chain signers. Reproduced here so the derivation
 * is tested against the decision it feeds, not only against itself.
 */
function phraseMatchesSigners(mnemonic: string, onChainSigners: Uint8Array[]): boolean {
  const { publicKey } = deriveP256KeyPair(mnemonic)
  const hex = bufferToHex(publicKey)
  return onChainSigners.some((s) => bufferToHex(s) === hex)
}

/** WebAuthn's signed message: authenticatorData || SHA-256(clientDataJSON). */
function webauthnMessage(authData: Uint8Array, clientDataJSON: Uint8Array): Uint8Array {
  const out = new Uint8Array(authData.length + 32)
  out.set(authData, 0)
  out.set(sha256(clientDataJSON), authData.length)
  return out
}

/** Verify a raw (r||s) P-256 signature the way a browser or the contract would. */
async function webCryptoVerify(publicKey: Uint8Array, rawSig: Uint8Array, message: Uint8Array): Promise<boolean> {
  const buf = (b: Uint8Array) => new Uint8Array(b) as Uint8Array<ArrayBuffer>
  const key = await crypto.subtle.importKey('raw', buf(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, buf(rawSig), buf(message))
}

// ── Phrase generation and key derivation ─────────────────────────────────────

describe('generateMnemonicPhrase', () => {
  it('produces a 12-word phrase with a valid BIP-39 checksum', () => {
    // Breaks: a phrase another BIP-39 tool rejects, or that the recover page
    // (which demands exactly 12 words) refuses to accept back.
    const phrase = generateMnemonicPhrase()
    expect(phrase.split(' ')).toHaveLength(12)
    expect(bip39.validateMnemonic(phrase, wordlist)).toBe(true)
  })

  it('never repeats', () => {
    // Breaks: a weak or seeded RNG — two users would share a recovery key.
    const seen = new Set(Array.from({ length: 50 }, () => generateMnemonicPhrase()))
    expect(seen.size).toBe(50)
  })
})

describe('deriveP256KeyPair', () => {
  it('derives the pinned signer for the BIP-39 test vector', () => {
    // Breaks: any change to the derivation. Every paper phrase already written
    // down would stop matching the signer it registered, i.e. every backup lost.
    expect(bufferToHex(bip39.mnemonicToSeedSync(VECTOR_MNEMONIC))).toBe(VECTOR_SEED_HEX)
    const { publicKey } = deriveP256KeyPair(VECTOR_MNEMONIC)
    expect(publicKey).toHaveLength(65)
    expect(publicKey[0]).toBe(0x04) // uncompressed: what the contract stores as BytesN<65>
    expect(bufferToHex(publicKey)).toBe(VECTOR_PUBLIC_KEY_HEX)
  })

  it('returns a private key that actually owns the public key', () => {
    // Breaks: a recovered wallet whose signatures never verify against its signer.
    const { privateKey, publicKey } = deriveP256KeyPair(VECTOR_MNEMONIC)
    expect(privateKey).toHaveLength(32)
    expect(bufferToHex(p256.getPublicKey(privateKey, false))).toBe(bufferToHex(publicKey))
  })

  it('is deterministic for a freshly generated phrase', () => {
    // Breaks: a backup that recovers a different key on the new device than
    // the one it registered on the old.
    const phrase = generateMnemonicPhrase()
    expect(bufferToHex(deriveP256KeyPair(phrase).publicKey)).toBe(bufferToHex(deriveP256KeyPair(phrase).publicKey))
  })
})

// ── Refusals: the wrong phrase must not recover the wallet ───────────────────

describe('a mismatched recovery phrase is refused', () => {
  const walletSigners = [deriveP256KeyPair(VECTOR_MNEMONIC).publicKey]

  it('accepts the phrase that registered the signer', () => {
    // Breaks: the right phrase cannot recover its own wallet.
    expect(phraseMatchesSigners(VECTOR_MNEMONIC, walletSigners)).toBe(true)
  })

  it('refuses a different, fully valid phrase', () => {
    // Breaks: someone else's backup opens this wallet.
    expect(bip39.validateMnemonic(NEIGHBOUR_MNEMONIC, wordlist)).toBe(true)
    expect(phraseMatchesSigners(NEIGHBOUR_MNEMONIC, walletSigners)).toBe(false)
  })

  it('refuses every random phrase', () => {
    // Breaks: a derivation that collapses many phrases onto one key.
    for (let i = 0; i < 20; i++) {
      expect(phraseMatchesSigners(generateMnemonicPhrase(), walletSigners)).toBe(false)
    }
  })

  it('refuses a phrase with a single word changed, even though its checksum fails', () => {
    // Partially valid input: deriveP256KeyPair does not validate the checksum,
    // so a typo derives *some* key. What matters is that it is not this
    // wallet's key. Breaks: a typo that silently resolves to the real wallet
    // (it cannot) — or, read the other way, this pins that a typo is caught by
    // the signer comparison and nowhere earlier.
    const typo = VECTOR_MNEMONIC.replace(/about$/, 'above')
    expect(bip39.validateMnemonic(typo, wordlist)).toBe(false)
    expect(() => deriveP256KeyPair(typo)).not.toThrow()
    expect(phraseMatchesSigners(typo, walletSigners)).toBe(false)
  })

  it('refuses the right words in the wrong order', () => {
    // Breaks: an order-insensitive derivation — 12! phrases would open one wallet.
    const words = VECTOR_MNEMONIC.split(' ')
    const swapped = [words[11], ...words.slice(1, 11), words[0]].join(' ')
    expect(phraseMatchesSigners(swapped, walletSigners)).toBe(false)
  })

  it('refuses the phrase typed in capitals or with a double space, rather than misreading it', () => {
    // The recover page trims the ends but does not normalise the middle, and
    // its 12-word check splits on any whitespace, so both of these get past
    // it. Capitals derive a different key and fail the signer comparison; a
    // double space makes BIP-39 count 13 words and throw. Both are the safe
    // failure (no wrong wallet is opened), and the error names no word of the
    // phrase. Pinned so a normalisation added later is a deliberate change.
    expect(phraseMatchesSigners(VECTOR_MNEMONIC.toUpperCase(), walletSigners)).toBe(false)
    const doubled = VECTOR_MNEMONIC.replace(' ', '  ')
    expect(doubled.split(/\s+/)).toHaveLength(12)
    expect(() => deriveP256KeyPair(doubled)).toThrow('Invalid mnemonic')
    try {
      deriveP256KeyPair(doubled)
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('abandon')
    }
  })

  it('refuses when the wallet has no signers at all', () => {
    // Breaks: an empty signer list read as "nothing to contradict the phrase".
    expect(phraseMatchesSigners(VECTOR_MNEMONIC, [])).toBe(false)
  })

  it('matches when the phrase signer is one of several', () => {
    // Breaks: recovery of a wallet that also has a passkey or guardian signer.
    const signers = [deriveP256KeyPair(NEIGHBOUR_MNEMONIC).publicKey, ...walletSigners]
    expect(phraseMatchesSigners(VECTOR_MNEMONIC, signers)).toBe(true)
  })
})

// ── signWithP256 ─────────────────────────────────────────────────────────────

describe('signWithP256', () => {
  const { privateKey, publicKey } = deriveP256KeyPair(VECTOR_MNEMONIC)
  const other = deriveP256KeyPair(NEIGHBOUR_MNEMONIC)
  const digest = sha256(new TextEncoder().encode('veil recovery test payload'))

  it('returns a 64-byte compact signature that verifies under the derived key', () => {
    // Breaks: the recovery key cannot authorise anything.
    const sig = signWithP256(digest, privateKey)
    expect(sig).toHaveLength(64)
    expect(p256.verify(sig, digest, publicKey)).toBe(true)
  })

  it('does not verify under a different wallet\'s key', () => {
    // Breaks: one recovery key's signature accepted for another wallet.
    expect(p256.verify(signWithP256(digest, privateKey), digest, other.publicKey)).toBe(false)
  })

  it('does not verify for a different payload', () => {
    // Breaks: a signature that can be replayed onto another transaction.
    const sig = signWithP256(digest, privateKey)
    const otherDigest = sha256(new TextEncoder().encode('a different payload'))
    expect(p256.verify(sig, otherDigest, publicKey)).toBe(false)
  })
})

// ── Encrypted backup of the phrase ───────────────────────────────────────────

describe('encryptMnemonic / decryptMnemonic', () => {
  const passphrase = 'correct horse battery staple'

  it('round-trips the phrase under the right passphrase', async () => {
    // Breaks: a backup that cannot be read back.
    const enc = await encryptMnemonic(VECTOR_MNEMONIC, passphrase)
    await expect(decryptMnemonic(enc, passphrase)).resolves.toBe(VECTOR_MNEMONIC)
  })

  it('stores only salt, iv and ciphertext — never the phrase or any word of it', async () => {
    // Breaks: the "encrypted" backup leaks the recovery phrase to anyone who
    // can read IndexedDB.
    const phrase = generateMnemonicPhrase()
    const enc = await encryptMnemonic(phrase, passphrase)
    const payload = JSON.parse(enc)
    expect(Object.keys(payload).sort()).toEqual(['ciphertext', 'iv', 'salt'])
    expect(Buffer.from(payload.salt, 'base64')).toHaveLength(16)
    expect(Buffer.from(payload.iv, 'base64')).toHaveLength(12)
    for (const word of phrase.split(' ')) expect(enc).not.toContain(word)
    expect(enc).not.toContain(passphrase)
  })

  it('uses a fresh salt and iv every time', async () => {
    // Breaks: AES-GCM iv reuse under one key, which leaks plaintext XOR.
    const a = JSON.parse(await encryptMnemonic(VECTOR_MNEMONIC, passphrase))
    const b = JSON.parse(await encryptMnemonic(VECTOR_MNEMONIC, passphrase))
    expect(a.salt).not.toBe(b.salt)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })

  it('still reads a backup written with PBKDF2-SHA256 at 100,000 iterations', async () => {
    // Built here with WebCrypto directly, not with encryptMnemonic. Breaks: a
    // change to the KDF (iterations, hash, key length) that makes every backup
    // already stored on users' devices undecryptable.
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    )
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(VECTOR_MNEMONIC))
    const stored = JSON.stringify({
      salt: Buffer.from(salt).toString('base64'),
      iv: Buffer.from(iv).toString('base64'),
      ciphertext: Buffer.from(ct).toString('base64'),
    })
    await expect(decryptMnemonic(stored, passphrase)).resolves.toBe(VECTOR_MNEMONIC)
  })

  it('refuses the wrong passphrase, and says nothing secret doing it', async () => {
    // Breaks: a wrong passphrase "decrypting" to garbage that is then shown or
    // used as a phrase — or an error message that echoes the secret.
    const enc = await encryptMnemonic(VECTOR_MNEMONIC, passphrase)
    const err = await decryptMnemonic(enc, 'correct horse battery stapler').then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).not.toBeNull()
    const text = String((err as Error)?.message ?? err)
    expect(text).not.toContain('abandon')
    expect(text).not.toContain(passphrase)
  })

  it('refuses an empty passphrase for a backup made with a real one', async () => {
    // Breaks: a blank field on the reveal form opening the backup.
    const enc = await encryptMnemonic(VECTOR_MNEMONIC, passphrase)
    await expect(decryptMnemonic(enc, '')).rejects.toBeDefined()
  })

  it('refuses a tampered ciphertext instead of returning altered words', async () => {
    // Breaks: GCM authentication not enforced — a modified backup would
    // "recover" a different phrase, i.e. a different wallet.
    const payload = JSON.parse(await encryptMnemonic(VECTOR_MNEMONIC, passphrase))
    const ct = Buffer.from(payload.ciphertext, 'base64')
    ct[0] ^= 0x01
    payload.ciphertext = ct.toString('base64')
    await expect(decryptMnemonic(JSON.stringify(payload), passphrase)).rejects.toBeDefined()
  })

  it('refuses a backup whose salt or iv was swapped for another backup\'s', async () => {
    // Breaks: parts of two backups combining into something that decrypts.
    const a = JSON.parse(await encryptMnemonic(VECTOR_MNEMONIC, passphrase))
    const b = JSON.parse(await encryptMnemonic(NEIGHBOUR_MNEMONIC, passphrase))
    await expect(decryptMnemonic(JSON.stringify({ ...a, salt: b.salt }), passphrase)).rejects.toBeDefined()
    await expect(decryptMnemonic(JSON.stringify({ ...a, iv: b.iv }), passphrase)).rejects.toBeDefined()
  })

  it('refuses a payload that is not a backup', async () => {
    // Partially valid input. Breaks: a corrupt record treated as an empty phrase.
    await expect(decryptMnemonic('not json', passphrase)).rejects.toBeDefined()
    await expect(decryptMnemonic('{}', passphrase)).rejects.toBeDefined()
    const { salt, iv } = JSON.parse(await encryptMnemonic(VECTOR_MNEMONIC, passphrase))
    await expect(decryptMnemonic(JSON.stringify({ salt, iv }), passphrase)).rejects.toBeDefined()
  })

  it('a decrypted backup re-derives the signer it was made for', async () => {
    // The whole self-custodial loop: backup → device lost → read back → sign.
    // Breaks: a backup that decrypts but no longer matches the wallet.
    const phrase = generateMnemonicPhrase()
    const signer = deriveP256KeyPair(phrase).publicKey
    const restored = await decryptMnemonic(await encryptMnemonic(phrase, passphrase), passphrase)
    expect(phraseMatchesSigners(restored, [signer])).toBe(true)
  })
})

// ── IndexedDB persistence ────────────────────────────────────────────────────

/**
 * Minimal IndexedDB with the request/transaction shape recovery.ts uses:
 * open → onupgradeneeded (first open) → onsuccess; transaction(...).objectStore
 * (...).put/get → onsuccess; tx.oncomplete. Callbacks fire asynchronously, as
 * the real API does.
 */
function installFakeIndexedDB(opts: { failOpen?: boolean; failPut?: boolean } = {}) {
  const databases = new Map<string, Map<string, Map<string, unknown>>>()
  let closes = 0
  const later = (fn: () => void) => setTimeout(fn, 0)

  const fake = {
    open(name: string, _version: number) {
      const req: any = { result: undefined, error: null }
      later(() => {
        if (opts.failOpen) {
          req.error = new Error('open blocked')
          req.onerror?.()
          return
        }
        const isNew = !databases.has(name)
        if (isNew) databases.set(name, new Map())
        const stores = databases.get(name)!
        req.result = {
          createObjectStore(store: string) {
            stores.set(store, new Map())
          },
          transaction(store: string, _mode: string) {
            const tx: any = {}
            const data = stores.get(store)
            if (!data) throw new Error(`NotFoundError: no object store ${store}`)
            tx.objectStore = () => ({
              put(value: unknown, key: string) {
                const r: any = { error: null }
                later(() => {
                  if (opts.failPut) {
                    r.error = new Error('quota exceeded')
                    r.onerror?.()
                  } else {
                    data.set(key, value)
                    r.onsuccess?.()
                  }
                  tx.oncomplete?.()
                })
                return r
              },
              get(key: string) {
                const r: any = { error: null }
                later(() => {
                  r.result = data.get(key)
                  r.onsuccess?.()
                  tx.oncomplete?.()
                })
                return r
              },
            })
            return tx
          },
          close() {
            closes++
          },
        }
        if (isNew) req.onupgradeneeded?.()
        req.onsuccess?.()
      })
      return req
    },
  }
  Object.defineProperty(globalThis, 'indexedDB', { value: fake, configurable: true, writable: true })
  return { databases, closes: () => closes }
}

function removeIndexedDB() {
  delete (globalThis as { indexedDB?: unknown }).indexedDB
}

describe('storeEncryptedMnemonic / getEncryptedMnemonic', () => {
  afterEach(removeIndexedDB)

  it('stores the encrypted backup and reads the same string back', async () => {
    // Breaks: the backup is written somewhere the reveal step never looks.
    const db = installFakeIndexedDB()
    const enc = await encryptMnemonic(VECTOR_MNEMONIC, 'pw')
    await storeEncryptedMnemonic(enc)
    await expect(getEncryptedMnemonic()).resolves.toBe(enc)
    expect(db.databases.get('VeilBackupDB')?.get('backup')?.get('encryptedMnemonic')).toBe(enc)
    expect(db.closes()).toBeGreaterThanOrEqual(2) // each call closes its connection
  })

  it('a later backup replaces the earlier one', async () => {
    // Breaks: a rotated phrase still restoring the old (possibly compromised) one.
    installFakeIndexedDB()
    await storeEncryptedMnemonic('first')
    await storeEncryptedMnemonic('second')
    await expect(getEncryptedMnemonic()).resolves.toBe('second')
  })

  it('reports no backup on a device that never made one', async () => {
    // Breaks: Settings claiming a backup exists when there is nothing to restore.
    installFakeIndexedDB()
    await expect(getEncryptedMnemonic()).resolves.toBeNull()
  })

  it('treats the empty string Settings writes on delete as no backup', async () => {
    // Settings "deletes" by storing ''. Breaks: a deleted backup still offered
    // for reveal, then failing to decrypt.
    installFakeIndexedDB()
    await storeEncryptedMnemonic('something')
    await storeEncryptedMnemonic('')
    await expect(getEncryptedMnemonic()).resolves.toBeNull()
  })

  it('rejects when the database cannot be opened, instead of reporting success', async () => {
    // Breaks: "backup saved" shown for a backup that was never written.
    installFakeIndexedDB({ failOpen: true })
    await expect(storeEncryptedMnemonic('x')).rejects.toThrow('open blocked')
    await expect(getEncryptedMnemonic()).rejects.toThrow('open blocked')
  })

  it('rejects when the write itself fails', async () => {
    // Breaks: a full disk silently losing the only copy of the phrase.
    installFakeIndexedDB({ failPut: true })
    await expect(storeEncryptedMnemonic('x')).rejects.toThrow('quota exceeded')
  })

  it('without IndexedDB (server render) stores nothing and finds nothing', async () => {
    // Breaks: a server-side render throwing on a browser-only API.
    removeIndexedDB()
    await expect(storeEncryptedMnemonic('x')).resolves.toBeUndefined()
    await expect(getEncryptedMnemonic()).resolves.toBeNull()
  })
})

// ── WebAuthn emulation primitives ────────────────────────────────────────────

describe('base64url', () => {
  it('encodes with the URL alphabet and no padding, as WebAuthn clientData does', () => {
    // Breaks: the challenge in clientDataJSON not matching what the contract
    // expects, so every recovery-key signature is rejected on chain.
    expect(base64url(new Uint8Array([]))).toBe('')
    expect(base64url(new Uint8Array([0xfb, 0xff]))).toBe('-_8')
    expect(base64url(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe('__79')
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    expect(base64url(bytes)).toBe(Buffer.from(bytes).toString('base64url'))
  })
})

describe('rawToDerSignature', () => {
  const { privateKey } = deriveP256KeyPair(VECTOR_MNEMONIC)

  it('round-trips through a strict DER parser, and the SDK\'s, for many real signatures', () => {
    // The interceptor hands callers DER; they decode it with the SDK's
    // derToRawSignature, which also folds s into the low half of the curve
    // order (the form Soroban's secp256r1 check accepts). So noble must read
    // back exactly what was signed, and the SDK its low-S equivalent, which
    // must still verify. Breaks: some fraction of recovery-key signatures (r or
    // s with the high bit set, or a leading zero) failing to decode or failing
    // on chain.
    const { publicKey } = deriveP256KeyPair(VECTOR_MNEMONIC)
    let sawHighS = false
    for (let i = 0; i < 200; i++) {
      const digest = sha256(new Uint8Array([i, i >> 8]))
      const raw = signWithP256(digest, privateKey)
      const der = rawToDerSignature(raw)
      const sig = p256.Signature.fromDER(der)
      expect(bufferToHex(sig.toCompactRawBytes())).toBe(bufferToHex(raw))
      if (sig.hasHighS()) sawHighS = true
      const sdkRaw = derToRawSignature(der.slice().buffer)
      expect(bufferToHex(sdkRaw)).toBe(bufferToHex(sig.normalizeS().toCompactRawBytes()))
      expect(p256.verify(sdkRaw, digest, publicKey, { lowS: true })).toBe(true)
    }
    // The fold was really exercised, not vacuously true.
    expect(sawHighS).toBe(true)
  })

  it('pads an integer whose high bit is set, so it is not read as negative', () => {
    // Breaks: DER that strict parsers (browsers, noble) reject.
    const raw = new Uint8Array(64)
    raw[0] = 0x80
    raw[31] = 0x01
    raw[32] = 0x01
    const der = rawToDerSignature(raw)
    expect(der[3]).toBe(33) // r length includes the 0x00 pad
    expect(der[4]).toBe(0x00)
    expect(der[5]).toBe(0x80)
  })

  it('strips leading zero bytes', () => {
    // Breaks: non-minimal DER, rejected by strict parsers.
    const raw = new Uint8Array(64)
    raw[30] = 0x12
    raw[31] = 0x34
    raw[63] = 0x05
    const der = rawToDerSignature(raw)
    expect(Array.from(der)).toEqual([0x30, 0x07, 0x02, 0x02, 0x12, 0x34, 0x02, 0x01, 0x05])
  })

  it('encodes a zero integer as a single 0x00 byte', () => {
    // Breaks: a zero-length INTEGER, which no parser accepts.
    const der = rawToDerSignature(new Uint8Array(64))
    expect(Array.from(der)).toEqual([0x30, 0x06, 0x02, 0x01, 0x00, 0x02, 0x01, 0x00])
  })
})

describe('generateRecoveryWebAuthnSignature', () => {
  const { privateKey, publicKey } = deriveP256KeyPair(VECTOR_MNEMONIC)
  const other = deriveP256KeyPair(NEIGHBOUR_MNEMONIC)
  const challenge = sha256(new TextEncoder().encode('soroban auth payload'))

  it('produces an assertion WebCrypto verifies under the recovery signer', async () => {
    // The contract checks secp256r1(sha256(authData || sha256(clientDataJSON))).
    // Breaks: a recovered wallet that cannot sign — recovery "succeeds" and
    // then every transaction fails.
    const a = generateRecoveryWebAuthnSignature(challenge, privateKey, publicKey, 'wallet.example', 'https://wallet.example')
    expect(await webCryptoVerify(publicKey, a.signature, webauthnMessage(a.authData, a.clientDataJSON))).toBe(true)
    expect(bufferToHex(a.publicKey)).toBe(bufferToHex(publicKey))
  })

  it('does not verify under another wallet\'s signer', async () => {
    // Breaks: a recovery key authorising a wallet it was never registered on.
    const a = generateRecoveryWebAuthnSignature(challenge, privateKey, publicKey, 'wallet.example', 'https://wallet.example')
    expect(await webCryptoVerify(other.publicKey, a.signature, webauthnMessage(a.authData, a.clientDataJSON))).toBe(false)
  })

  it('signs a key that is not the stated public key, and that signature fails against it', async () => {
    // The function trusts its caller to pair the keys; the interceptor now
    // checks the pairing before calling it (recoveryInterceptor.test.ts).
    // Breaks: if this ever verified, the pairing check would be pointless.
    const a = generateRecoveryWebAuthnSignature(challenge, other.privateKey, publicKey, 'wallet.example', 'https://wallet.example')
    expect(await webCryptoVerify(publicKey, a.signature, webauthnMessage(a.authData, a.clientDataJSON))).toBe(false)
  })

  it('binds the challenge: the signature fails for any other challenge', async () => {
    // Breaks: one emulated assertion replayable for a different transaction.
    const a = generateRecoveryWebAuthnSignature(challenge, privateKey, publicKey, 'wallet.example', 'https://wallet.example')
    const forged = new TextEncoder().encode(
      new TextDecoder().decode(a.clientDataJSON).replace(base64url(challenge), base64url(new Uint8Array(32))),
    )
    expect(await webCryptoVerify(publicKey, a.signature, webauthnMessage(a.authData, forged))).toBe(false)
  })

  it('writes clientDataJSON and authenticatorData the way a real authenticator does', () => {
    // Breaks: the contract's clientData / rpIdHash checks rejecting the recovery key.
    const a = generateRecoveryWebAuthnSignature(challenge, privateKey, publicKey, 'wallet.example', 'https://wallet.example')
    expect(JSON.parse(new TextDecoder().decode(a.clientDataJSON))).toEqual({
      type: 'webauthn.get',
      challenge: base64url(challenge),
      origin: 'https://wallet.example',
      crossOrigin: false,
    })
    expect(a.authData).toHaveLength(37)
    expect(bufferToHex(a.authData.slice(0, 32))).toBe(bufferToHex(sha256(new TextEncoder().encode('wallet.example'))))
    expect(a.authData[32]).toBe(0x05) // user present + user verified
    expect(Array.from(a.authData.slice(33))).toEqual([0, 0, 0, 0]) // sign count
  })

  it('outside a browser defaults to localhost', () => {
    // Breaks: a server-side caller crashing on `window`.
    const a = generateRecoveryWebAuthnSignature(challenge, privateKey, publicKey)
    const cd = JSON.parse(new TextDecoder().decode(a.clientDataJSON))
    expect(cd.origin).toBe('https://localhost')
    expect(bufferToHex(a.authData.slice(0, 32))).toBe(bufferToHex(sha256(new TextEncoder().encode('localhost'))))
  })
})

describe('initRecoveryInterceptor outside a browser', () => {
  it('does nothing when there is no window', () => {
    // Breaks: WalletProvider's import crashing a server render.
    expect(typeof window).toBe('undefined')
    expect(() => initRecoveryInterceptor()).not.toThrow()
  })
})

// ── SEP-30 server-assisted recovery ──────────────────────────────────────────

// Addresses are derived, not typed: a hand-written strkey is easy to truncate
// or invent. Each is a valid, full-length strkey of a fixed test seed.
const testSeed = (label: string) => Buffer.from(sha256(new TextEncoder().encode(`veil #1204 ${label}`)))
const WALLET = StrKey.encodeContract(testSeed('wallet'))
const OTHER_WALLET = StrKey.encodeContract(testSeed('other wallet'))
const SIGNER_A = Keypair.fromRawEd25519Seed(testSeed('server a')).publicKey()
const SIGNER_B = Keypair.fromRawEd25519Seed(testSeed('server b')).publicKey()
const TX_XDR = 'AAAAAgAAAAA=' // opaque to the client; only passed through

type Route = (init: { method: string; body?: unknown; auth?: string }) => { status: number; body?: unknown }

function installFetch(routes: Record<string, Route>) {
  const calls: Array<{ url: string; method: string; body?: unknown; auth?: string }> = []
  const fetchMock = jest.fn(async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    const call = { url, method: String(init.method), body, auth: headers.Authorization }
    calls.push(call)
    const key = `${init.method} ${url}`
    const route = routes[key]
    const res = route ? route(call) : { status: 404, body: { error: 'not found' } }
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      text: async () => (res.body === undefined ? '' : JSON.stringify(res.body)),
    } as unknown as Response
  })
  Object.defineProperty(globalThis, 'fetch', { value: fetchMock, configurable: true, writable: true })
  return calls
}

function installLocalStorage() {
  const store = new Map<string, string>()
  const ls = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true })
  return store
}

const originalFetch = globalThis.fetch
afterEach(() => {
  Object.defineProperty(globalThis, 'fetch', { value: originalFetch, configurable: true, writable: true })
  delete (globalThis as { localStorage?: unknown }).localStorage
})

const account = (address: string, signer?: string) => ({
  address,
  identities: [{ role: 'owner', authenticated: true }],
  signers: signer ? [{ key: signer }] : [],
})

describe('buildRecoveryClients', () => {
  it('builds one client per server, each talking to its own base URL', async () => {
    // Breaks: identities registered with one server and recovery asked of another.
    const calls = installFetch({
      [`GET https://a.example/accounts/${WALLET}`]: () => ({ status: 200, body: account(WALLET, SIGNER_A) }),
      [`GET https://b.example/accounts/${WALLET}`]: () => ({ status: 200, body: account(WALLET, SIGNER_B) }),
    })
    const clients = buildRecoveryClients([{ baseUrl: 'https://a.example/' }, { baseUrl: 'https://b.example' }])
    expect(clients).toHaveLength(2)
    await Promise.all(clients.map((c) => c.getAccount(WALLET)))
    expect(calls.map((c) => c.url)).toEqual([
      `https://a.example/accounts/${WALLET}`,
      `https://b.example/accounts/${WALLET}`,
    ])
  })

  it('refuses a server with no base URL', () => {
    // Breaks: a misconfigured server silently requesting relative paths.
    expect(() => buildRecoveryClients([{ baseUrl: '' }])).toThrow('baseUrl')
  })
})

describe('rememberRecoveryServers / getRememberedRecoveryServers', () => {
  it('remembers the server URLs and never the tokens', () => {
    // Breaks: a SEP-10 JWT persisted in localStorage, or the servers forgotten
    // so a user cannot find them after losing the device.
    const store = installLocalStorage()
    rememberRecoveryServers([
      { baseUrl: 'https://a.example', authToken: 'jwt-secret-a' },
      { baseUrl: 'https://b.example', getAuthToken: () => 'jwt-secret-b' },
    ])
    expect(getRememberedRecoveryServers()).toEqual(['https://a.example', 'https://b.example'])
    const everything = Array.from(store.values()).join('\n')
    expect(everything).not.toContain('jwt-secret')
  })

  it('returns nothing for an absent, corrupt or non-list record', () => {
    // Partially valid input. Breaks: a corrupt record crashing the recover page.
    const store = installLocalStorage()
    expect(getRememberedRecoveryServers()).toEqual([])
    store.set('invisible_wallet_recovery_servers', '{not json')
    expect(getRememberedRecoveryServers()).toEqual([])
    store.set('invisible_wallet_recovery_servers', '{"baseUrl":"https://a.example"}')
    expect(getRememberedRecoveryServers()).toEqual([])
  })

  it('without localStorage, remembers nothing and returns nothing', () => {
    // Breaks: a server render throwing.
    expect(() => rememberRecoveryServers([{ baseUrl: 'https://a.example' }])).not.toThrow()
    expect(getRememberedRecoveryServers()).toEqual([])
  })
})

describe('registerWithRecoveryServers', () => {
  const identities = [{ role: 'owner', auth_methods: [{ type: 'email', value: 'owner@example.com' }] }]

  it('registers with every server, sends the token, and remembers the servers', async () => {
    // Breaks: a server silently left out of a 2-of-2 recovery.
    installLocalStorage()
    const calls = installFetch({
      [`POST https://a.example/accounts/${WALLET}`]: () => ({ status: 200, body: account(WALLET, SIGNER_A) }),
      [`POST https://b.example/accounts/${WALLET}`]: () => ({ status: 200, body: account(WALLET, SIGNER_B) }),
    })
    const accounts = await registerWithRecoveryServers(WALLET, identities, [
      { baseUrl: 'https://a.example', authToken: 'jwt-a' },
      { baseUrl: 'https://b.example', getAuthToken: async () => 'jwt-b' },
    ])
    expect(accounts.map((a) => a.signers[0].key)).toEqual([SIGNER_A, SIGNER_B])
    expect(calls.map((c) => c.body)).toEqual([{ identities }, { identities }])
    expect(calls.map((c) => c.auth)).toEqual(['Bearer jwt-a', 'Bearer jwt-b'])
    expect(getRememberedRecoveryServers()).toEqual(['https://a.example', 'https://b.example'])
  })

  it('fails as a whole if any server refuses, and does not remember a half-registration', async () => {
    // Breaks: the wallet believing it is recoverable through a server that
    // never registered it.
    installLocalStorage()
    installFetch({
      [`POST https://a.example/accounts/${WALLET}`]: () => ({ status: 200, body: account(WALLET, SIGNER_A) }),
      [`POST https://b.example/accounts/${WALLET}`]: () => ({ status: 401, body: { error: 'unauthorized' } }),
    })
    const err = await registerWithRecoveryServers(WALLET, identities, [
      { baseUrl: 'https://a.example' },
      { baseUrl: 'https://b.example' },
    ]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Sep30Error)
    expect((err as Sep30Error).status).toBe(401)
    expect(getRememberedRecoveryServers()).toEqual([])
  })
})

describe('resolveRecoveryServers', () => {
  it('pairs each server that knows the account with the signer it contributes', async () => {
    // Breaks: recovery asking a server to sign with a key it does not hold.
    installFetch({
      [`GET https://a.example/accounts/${WALLET}`]: () => ({ status: 200, body: account(WALLET, SIGNER_A) }),
      [`GET https://b.example/accounts/${WALLET}`]: () => ({ status: 200, body: account(WALLET, SIGNER_B) }),
    })
    const servers = await resolveRecoveryServers(WALLET, [{ baseUrl: 'https://a.example' }, { baseUrl: 'https://b.example' }])
    expect(servers.map((s) => s.signerKey)).toEqual([SIGNER_A, SIGNER_B])
  })

  it('skips a server that does not have the account, or errors', async () => {
    // Breaks: one unreachable server blocking an M-of-N recovery outright.
    installFetch({
      [`GET https://a.example/accounts/${WALLET}`]: () => ({ status: 200, body: account(WALLET, SIGNER_A) }),
      [`GET https://c.example/accounts/${WALLET}`]: () => ({ status: 500, body: { error: 'down' } }),
    })
    const servers = await resolveRecoveryServers(WALLET, [
      { baseUrl: 'https://a.example' },
      { baseUrl: 'https://b.example' }, // 404
      { baseUrl: 'https://c.example' }, // 500
    ])
    expect(servers.map((s) => s.signerKey)).toEqual([SIGNER_A])
  })

  it('skips a server that has the account but no signer for it', async () => {
    // Breaks: an empty signer key sent to /sign/, which signs nothing useful.
    installFetch({
      [`GET https://a.example/accounts/${WALLET}`]: () => ({ status: 200, body: account(WALLET) }),
    })
    await expect(resolveRecoveryServers(WALLET, [{ baseUrl: 'https://a.example' }])).resolves.toEqual([])
  })

  it('refuses a server that answers for a different account', async () => {
    // The mismatched credential, server-side: its signer belongs to another
    // wallet and cannot recover this one. Breaks: that signer counted toward
    // this wallet's recovery threshold.
    installFetch({
      [`GET https://a.example/accounts/${WALLET}`]: () => ({ status: 200, body: account(OTHER_WALLET, SIGNER_A) }),
      [`GET https://b.example/accounts/${WALLET}`]: () => ({ status: 200, body: account(WALLET, SIGNER_B) }),
    })
    const servers = await resolveRecoveryServers(WALLET, [{ baseUrl: 'https://a.example' }, { baseUrl: 'https://b.example' }])
    expect(servers.map((s) => s.signerKey)).toEqual([SIGNER_B])
  })
})

describe('recoverSignatures', () => {
  const sign = (signer: string) => (call: { body?: unknown }) => {
    expect(call.body).toEqual({ transaction: TX_XDR })
    return { status: 200, body: { signature: `sig-from-${signer}`, network_passphrase: 'Test SDF Network ; September 2015' } }
  }

  async function resolved() {
    return resolveRecoveryServers(WALLET, [{ baseUrl: 'https://a.example' }, { baseUrl: 'https://b.example' }])
  }

  it('collects one signature per server, tagged with the signer that made it', async () => {
    // Breaks: signatures attached to the transaction under the wrong signer.
    installFetch({
      [`GET https://a.example/accounts/${WALLET}`]: () => ({ status: 200, body: account(WALLET, SIGNER_A) }),
      [`GET https://b.example/accounts/${WALLET}`]: () => ({ status: 200, body: account(WALLET, SIGNER_B) }),
      [`POST https://a.example/accounts/${WALLET}/sign/${SIGNER_A}`]: sign(SIGNER_A),
      [`POST https://b.example/accounts/${WALLET}/sign/${SIGNER_B}`]: sign(SIGNER_B),
    })
    const sigs = await recoverSignatures(await resolved(), WALLET, TX_XDR)
    expect(sigs.map((s) => [s.signerKey, s.signature])).toEqual([
      [SIGNER_A, `sig-from-${SIGNER_A}`],
      [SIGNER_B, `sig-from-${SIGNER_B}`],
    ])
  })

  it('by default refuses to return a partial set when any server declines', async () => {
    // Breaks: a 2-of-2 recovery submitted with one signature, failing on chain
    // after the user has re-authenticated every identity.
    installFetch({
      [`GET https://a.example/accounts/${WALLET}`]: () => ({ status: 200, body: account(WALLET, SIGNER_A) }),
      [`GET https://b.example/accounts/${WALLET}`]: () => ({ status: 200, body: account(WALLET, SIGNER_B) }),
      [`POST https://a.example/accounts/${WALLET}/sign/${SIGNER_A}`]: sign(SIGNER_A),
      [`POST https://b.example/accounts/${WALLET}/sign/${SIGNER_B}`]: () => ({ status: 403, body: { error: 'identity not authenticated' } }),
    })
    await expect(recoverSignatures(await resolved(), WALLET, TX_XDR)).rejects.toThrow('identity not authenticated')
  })

  it('with requireAll: false returns what succeeded, for an M-of-N threshold', async () => {
    // Breaks: one offline server making an M-of-N recovery impossible.
    installFetch({
      [`GET https://a.example/accounts/${WALLET}`]: () => ({ status: 200, body: account(WALLET, SIGNER_A) }),
      [`GET https://b.example/accounts/${WALLET}`]: () => ({ status: 200, body: account(WALLET, SIGNER_B) }),
      [`POST https://a.example/accounts/${WALLET}/sign/${SIGNER_A}`]: sign(SIGNER_A),
      [`POST https://b.example/accounts/${WALLET}/sign/${SIGNER_B}`]: () => ({ status: 503 }),
    })
    const sigs = await recoverSignatures(await resolved(), WALLET, TX_XDR, { requireAll: false })
    expect(sigs.map((s) => s.signerKey)).toEqual([SIGNER_A])
  })

  it('with no servers returns no signatures rather than inventing any', async () => {
    // Breaks: an empty server list read as "recovery authorised".
    await expect(recoverSignatures([], WALLET, TX_XDR)).resolves.toEqual([])
  })
})
