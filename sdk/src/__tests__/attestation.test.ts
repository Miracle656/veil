/**
 * Tests for WebAuthn attestation verification.
 *
 * A real `packed` self-attestation fixture is constructed in-test using Node's
 * WebCrypto: we generate a P-256 key pair, build authData embedding the COSE
 * public key, sign (authData ‖ clientDataHash), and assemble the CBOR
 * attestationObject. No external dependencies or network access required.
 */

import { webcrypto } from 'node:crypto'
import {
  verifyAttestation,
  AttestationError,
  AttestationPolicyError,
  type AttestationInfo,
} from '../webauthn/attestation'

// The attestation module uses the global `crypto.subtle`; provide Node's.
beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, writable: true, configurable: true })
})

const subtle = webcrypto.subtle

// ── Tiny CBOR encoder (just enough to build the fixture) ────────────────────────

type CborMap = Array<[number | string, unknown]>

function encodeHead(major: number, n: number): Uint8Array {
  if (n < 24) return new Uint8Array([(major << 5) | n])
  if (n < 0x100) return new Uint8Array([(major << 5) | 24, n])
  if (n < 0x10000) return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff])
  return new Uint8Array([(major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff])
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

function cbor(value: unknown): Uint8Array {
  if (typeof value === 'number') {
    return value >= 0 ? encodeHead(0, value) : encodeHead(1, -1 - value)
  }
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value)
    return concat(encodeHead(3, bytes.length), bytes)
  }
  if (value instanceof Uint8Array) {
    return concat(encodeHead(2, value.length), value)
  }
  if (Array.isArray(value) && value.every(v => Array.isArray(v))) {
    // map represented as [[k,v],...]
    const entries = value as CborMap
    const parts = [encodeHead(5, entries.length)]
    for (const [k, v] of entries) { parts.push(cbor(k), cbor(v)) }
    return concat(...parts)
  }
  if (Array.isArray(value)) {
    const parts = [encodeHead(4, value.length)]
    for (const v of value) parts.push(cbor(v))
    return concat(...parts)
  }
  throw new Error('cbor: unsupported fixture value')
}

// ── raw (r‖s) → DER ─────────────────────────────────────────────────────────────

function rawToDer(raw: Uint8Array): Uint8Array {
  const r = raw.slice(0, 32)
  const s = raw.slice(32, 64)
  const fmt = (b: Uint8Array): Uint8Array => {
    let i = 0
    while (i < b.length - 1 && b[i] === 0) i++
    let t: Uint8Array = b.slice(i)
    if (t[0] & 0x80) t = concat(new Uint8Array([0]), t)
    return t
  }
  const rd = fmt(r), sd = fmt(s)
  const body = concat(new Uint8Array([0x02, rd.length]), rd, new Uint8Array([0x02, sd.length]), sd)
  return concat(new Uint8Array([0x30, body.length]), body)
}

// ── Fixture builder ─────────────────────────────────────────────────────────────

const AAGUID = new Uint8Array(16).fill(0xab)
const CRED_ID = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
const RP_ID_HASH = new Uint8Array(32).fill(0x11)

async function buildPackedSelfAttestation(opts: { tamperSig?: boolean } = {}) {
  const keyPair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const rawPub = new Uint8Array(await subtle.exportKey('raw', keyPair.publicKey)) // 0x04‖x‖y
  const x = rawPub.slice(1, 33)
  const y = rawPub.slice(33, 65)

  // COSE_Key for EC2 / P-256 / ES256
  const cose = cbor([
    [1, 2],     // kty: EC2
    [3, -7],    // alg: ES256
    [-1, 1],    // crv: P-256
    [-2, x],
    [-3, y],
  ] as CborMap)

  // authData: rpIdHash(32) | flags(1) | signCount(4) | aaguid(16) | credIdLen(2) | credId | cose
  const header = new Uint8Array(37)
  header.set(RP_ID_HASH, 0)
  header[32] = 0x41 // UP | AT
  new DataView(header.buffer).setUint32(33, 7, false) // signCount = 7
  const credIdLen = new Uint8Array([0x00, CRED_ID.length])
  const authData = concat(header, AAGUID, credIdLen, CRED_ID, cose)

  const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.create', challenge: 'abc', origin: 'https://veil.app' }))
  const clientDataHash = new Uint8Array(await subtle.digest('SHA-256', clientDataJSON))

  const signedData = concat(authData, clientDataHash)
  const rawSig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, signedData))
  if (opts.tamperSig) rawSig[10] ^= 0xff
  const derSig = rawToDer(rawSig)

  const attestationObject = cbor([
    ['fmt', 'packed'],
    ['attStmt', [['alg', -7], ['sig', derSig]] as CborMap],
    ['authData', authData],
  ] as CborMap)

  return { attestationObject, clientDataJSON, publicKey: rawPub }
}

function buildNoneAttestation(): { attestationObject: Uint8Array; clientDataJSON: Uint8Array } {
  const header = new Uint8Array(37)
  header.set(RP_ID_HASH, 0)
  header[32] = 0x41
  new DataView(header.buffer).setUint32(33, 0, false)
  // include a minimal COSE key so the public key is parseable too
  const cose = cbor([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(32).fill(1)], [-3, new Uint8Array(32).fill(2)]] as CborMap)
  const authData = concat(header, AAGUID, new Uint8Array([0x00, CRED_ID.length]), CRED_ID, cose)
  const attestationObject = cbor([['fmt', 'none'], ['attStmt', [] as CborMap], ['authData', authData]] as CborMap)
  return { attestationObject, clientDataJSON: new TextEncoder().encode('{}') }
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe('verifyAttestation', () => {
  it('parses and verifies a packed self-attestation signature', async () => {
    const fx = await buildPackedSelfAttestation()
    const info = await verifyAttestation({ attestationObject: fx.attestationObject, clientDataJSON: fx.clientDataJSON })

    expect(info.fmt).toBe('packed')
    expect(info.attestationType).toBe('self')
    expect(info.verified).toBe(true)
    expect(info.aaguid).toBe('ab'.repeat(16))
    expect(Array.from(info.credentialId)).toEqual(Array.from(CRED_ID))
    expect(info.signCount).toBe(7)
    expect(info.publicKey && Array.from(info.publicKey)).toEqual(Array.from(fx.publicKey))
  })

  it('throws AttestationError when the signature is tampered (requireValidSignature default)', async () => {
    const fx = await buildPackedSelfAttestation({ tamperSig: true })
    await expect(
      verifyAttestation({ attestationObject: fx.attestationObject, clientDataJSON: fx.clientDataJSON }),
    ).rejects.toThrow(AttestationError)
  })

  it('records verified:false instead of throwing when requireValidSignature is false', async () => {
    const fx = await buildPackedSelfAttestation({ tamperSig: true })
    const info = await verifyAttestation({
      attestationObject: fx.attestationObject,
      clientDataJSON: fx.clientDataJSON,
      requireValidSignature: false,
    })
    expect(info.verified).toBe(false)
  })

  it('handles the "none" format: parses AAGUID/key but reports unverified', async () => {
    const fx = buildNoneAttestation()
    const info = await verifyAttestation({ attestationObject: fx.attestationObject, clientDataJSON: fx.clientDataJSON })
    expect(info.fmt).toBe('none')
    expect(info.attestationType).toBe('none')
    expect(info.verified).toBe(false)
    expect(info.aaguid).toBe('ab'.repeat(16))
    expect(info.publicKey).toBeDefined()
  })

  // ── policy hook ───────────────────────────────────────────────────────────────

  it('accepts when the policy approves (by AAGUID)', async () => {
    const fx = await buildPackedSelfAttestation()
    const allowed = new Set(['ab'.repeat(16)])
    const policy = (i: AttestationInfo) => i.verified && allowed.has(i.aaguid)
    const info = await verifyAttestation({ attestationObject: fx.attestationObject, clientDataJSON: fx.clientDataJSON, policy })
    expect(info.verified).toBe(true)
  })

  it('rejects with AttestationPolicyError when the policy returns false', async () => {
    const fx = await buildPackedSelfAttestation()
    const policy = (i: AttestationInfo) => i.aaguid === 'deadbeef' // never matches
    await expect(
      verifyAttestation({ attestationObject: fx.attestationObject, clientDataJSON: fx.clientDataJSON, policy }),
    ).rejects.toThrow(AttestationPolicyError)
  })

  it('rejects by format via the policy (reject unattested "none")', async () => {
    const fx = buildNoneAttestation()
    const policy = (i: AttestationInfo) => i.fmt !== 'none'
    await expect(
      verifyAttestation({ attestationObject: fx.attestationObject, clientDataJSON: fx.clientDataJSON, policy }),
    ).rejects.toThrow(AttestationPolicyError)
  })

  it('throws on a malformed attestationObject', async () => {
    await expect(
      verifyAttestation({ attestationObject: new Uint8Array([0x01, 0x02]), clientDataJSON: new Uint8Array() }),
    ).rejects.toThrow(AttestationError)
  })
})
