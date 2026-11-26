import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { StrKey } from '@stellar/stellar-sdk'
import {
  base64UrlEncode,
  derivePaymentChallenge,
  derToRawEcdsa,
  verifyPaymentAssertion,
  type AssertionParts,
  type PaymentDescriptor,
} from './challenge'

const subtle = webcrypto.subtle

const PAYMENT: PaymentDescriptor = {
  scheme: 'exact',
  network: 'stellar:testnet',
  asset: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  amount: '100000',
  payTo: 'GB5LAR3EKF6A6RXHDGDEF5UNVGJDXYPZXUDICACGTDUNSUOYG32BWMP7',
  resource: 'http://localhost:4021/paid/quote',
  maxTimeoutSeconds: 120,
}

test('fixture addresses are checksum-valid', () => {
  assert.ok(StrKey.isValidContract(PAYMENT.asset))
  assert.ok(StrKey.isValidContract('CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA'))
  assert.ok(StrKey.isValidEd25519PublicKey(PAYMENT.payTo))
  assert.ok(StrKey.isValidEd25519PublicKey('GDVPZXCMBMDD5SZQAA5WYUGZKZLBO5KWNSNIU3LKDR5NSHJVOFZLWTYT'))
})

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

test('challenge is 32 bytes and deterministic for the same payment', async () => {
  const a = await derivePaymentChallenge(PAYMENT)
  const b = await derivePaymentChallenge({ ...PAYMENT })
  assert.equal(a.length, 32)
  assert.equal(hex(a), hex(b))
})

test('a different payment produces a different challenge', async () => {
  const base = hex(await derivePaymentChallenge(PAYMENT))
  const variants: Partial<PaymentDescriptor>[] = [
    { amount: '100001' },
    { payTo: 'GDVPZXCMBMDD5SZQAA5WYUGZKZLBO5KWNSNIU3LKDR5NSHJVOFZLWTYT' },
    { asset: 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA' },
    { network: 'stellar:pubnet' },
    { resource: 'http://localhost:4021/paid/other' },
    { maxTimeoutSeconds: 121 },
    { scheme: 'upto' },
  ]
  const seen = new Set([base])
  for (const v of variants) {
    const c = hex(await derivePaymentChallenge({ ...PAYMENT, ...v }))
    assert.ok(!seen.has(c), `variant ${JSON.stringify(v)} collided`)
    seen.add(c)
  }
})

test('field boundaries cannot be shifted to collide', async () => {
  const a = await derivePaymentChallenge({ ...PAYMENT, asset: 'AB', amount: 'C' })
  const b = await derivePaymentChallenge({ ...PAYMENT, asset: 'A', amount: 'BC' })
  assert.notEqual(hex(a), hex(b))
})

// --- assertion verification, using a real P-256 passkey stand-in -----------

async function makePasskey() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const spki = new Uint8Array(await subtle.exportKey('spki', pair.publicKey))
  return { pair, spki }
}

function rawToDer(raw: Uint8Array): Uint8Array {
  const enc = (n: Uint8Array) => {
    let v = n
    while (v.length > 1 && v[0] === 0) v = v.slice(1)
    if (v[0] & 0x80) v = Uint8Array.from([0, ...v])
    return Uint8Array.from([0x02, v.length, ...v])
  }
  const r = enc(raw.slice(0, 32))
  const s = enc(raw.slice(32))
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s])
}

async function assertOver(
  pair: CryptoKeyPair,
  challenge: Uint8Array,
  opts: { flags?: number; type?: string } = {},
): Promise<AssertionParts> {
  const clientDataJSON = new TextEncoder().encode(
    JSON.stringify({
      type: opts.type ?? 'webauthn.get',
      challenge: base64UrlEncode(challenge),
      origin: 'http://localhost:3000',
    }),
  )
  const authenticatorData = new Uint8Array(37)
  authenticatorData[32] = opts.flags ?? 0x05
  const hash = new Uint8Array(await subtle.digest('SHA-256', clientDataJSON))
  const signed = Uint8Array.from([...authenticatorData, ...hash])
  const raw = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, signed))
  return { clientDataJSON, authenticatorData, signature: rawToDer(raw) }
}

test('an assertion over the payment challenge verifies', async () => {
  const { pair, spki } = await makePasskey()
  const challenge = await derivePaymentChallenge(PAYMENT)
  const parts = await assertOver(pair, challenge)
  await verifyPaymentAssertion({ parts, expectedChallenge: challenge, publicKeySpki: spki })
})

test('an assertion made for a different payment is rejected', async () => {
  const { pair, spki } = await makePasskey()
  const cheap = await derivePaymentChallenge(PAYMENT)
  const expensive = await derivePaymentChallenge({ ...PAYMENT, amount: '900000000' })
  const parts = await assertOver(pair, cheap)
  await assert.rejects(
    verifyPaymentAssertion({ parts, expectedChallenge: expensive, publicKeySpki: spki }),
    /challenge mismatch/,
  )
})

test('a random-challenge (presence-only) assertion is rejected', async () => {
  const { pair, spki } = await makePasskey()
  const expected = await derivePaymentChallenge(PAYMENT)
  const random = webcrypto.getRandomValues(new Uint8Array(32))
  const parts = await assertOver(pair, random)
  await assert.rejects(
    verifyPaymentAssertion({ parts, expectedChallenge: expected, publicKeySpki: spki }),
    /challenge mismatch/,
  )
})

test('an assertion signed by a different key is rejected', async () => {
  const { pair } = await makePasskey()
  const other = await makePasskey()
  const challenge = await derivePaymentChallenge(PAYMENT)
  const parts = await assertOver(pair, challenge)
  await assert.rejects(
    verifyPaymentAssertion({ parts, expectedChallenge: challenge, publicKeySpki: other.spki }),
    /signature is invalid/,
  )
})

test('assertions without user verification, or of the wrong type, are rejected', async () => {
  const { pair, spki } = await makePasskey()
  const challenge = await derivePaymentChallenge(PAYMENT)
  await assert.rejects(
    verifyPaymentAssertion({
      parts: await assertOver(pair, challenge, { flags: 0x01 }),
      expectedChallenge: challenge,
      publicKeySpki: spki,
    }),
    /user verification/,
  )
  await assert.rejects(
    verifyPaymentAssertion({
      parts: await assertOver(pair, challenge, { type: 'webauthn.create' }),
      expectedChallenge: challenge,
      publicKeySpki: spki,
    }),
    /webauthn\.get/,
  )
})

test('DER signatures with padded and short integers convert to 64 raw bytes', () => {
  const r = new Uint8Array(32).fill(0xff)
  const s = new Uint8Array(32)
  s[31] = 1
  const raw = new Uint8Array(64)
  raw.set(r, 0)
  raw.set(s, 32)
  assert.equal(hex(derToRawEcdsa(rawToDer(raw))), hex(raw))
  assert.throws(() => derToRawEcdsa(Uint8Array.from([0x31, 0x00])), /Malformed/)
})
