/**
 * Payment-bound passkey challenges.
 *
 * A WebAuthn prompt only means something if its challenge commits to what the
 * user is agreeing to. A random challenge proves "a human was present at some
 * moment"; a challenge derived from the payment proves "a human approved
 * *this* amount to *this* recipient on *this* network".
 *
 * This module is dependency-free (Web Crypto only) so it can be unit-tested in
 * plain Node and reused outside the Next.js app.
 */

/** The parts of an x402 payment requirement the user is agreeing to. */
export interface PaymentDescriptor {
  scheme: string
  /** CAIP-2 network id, e.g. `stellar:testnet`. */
  network: string
  /** Asset contract (SAC) address being paid. */
  asset: string
  /** Amount in the asset's smallest unit (stroops for XLM). */
  amount: string
  /** Recipient address. */
  payTo: string
  /** Resource being bought (the URL that returned 402). */
  resource: string
  /** How long the payment stays valid, as the server requires it. */
  maxTimeoutSeconds: number
}

/** Bumped whenever the canonical encoding below changes. */
const DOMAIN = 'veil-x402-payment-challenge-v1'

/**
 * Canonical, unambiguous encoding of a descriptor. Fields are emitted in a
 * fixed order and JSON-encoded (so no field value can smuggle in a separator).
 */
export function canonicalizePayment(d: PaymentDescriptor): string {
  return JSON.stringify([
    DOMAIN,
    d.scheme,
    d.network,
    d.asset,
    d.amount,
    d.payTo,
    d.resource,
    d.maxTimeoutSeconds,
  ])
}

/** SHA-256 of the canonical payment: the 32-byte WebAuthn challenge. */
export async function derivePaymentChallenge(d: PaymentDescriptor): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(canonicalizePayment(d))
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

/** The pieces of a WebAuthn assertion needed to check it, all as raw bytes. */
export interface AssertionParts {
  clientDataJSON: Uint8Array
  authenticatorData: Uint8Array
  /** DER-encoded ECDSA signature, as returned by `AuthenticatorAssertionResponse`. */
  signature: Uint8Array
}

/** What is kept alongside a payment once its passkey assertion has verified. */
export interface AssertionRecord {
  /** base64url of the challenge the assertion was made over. */
  challenge: string
  /** base64url of the raw assertion pieces, so the approval can be audited later. */
  clientDataJSON: string
  authenticatorData: string
  signature: string
}

export function toAssertionRecord(challenge: Uint8Array, parts: AssertionParts): AssertionRecord {
  return {
    challenge: base64UrlEncode(challenge),
    clientDataJSON: base64UrlEncode(parts.clientDataJSON),
    authenticatorData: base64UrlEncode(parts.authenticatorData),
    signature: base64UrlEncode(parts.signature),
  }
}

/**
 * Verifies that `parts` is a genuine assertion, by the passkey whose SPKI public
 * key is `publicKeySpki`, over exactly `expectedChallenge`. Throws on any
 * mismatch, so a payment can be refused before anything is signed.
 *
 * Supports ES256 (P-256), the algorithm the example registers.
 */
export async function verifyPaymentAssertion(args: {
  parts: AssertionParts
  expectedChallenge: Uint8Array
  publicKeySpki: Uint8Array
}): Promise<void> {
  const { parts, expectedChallenge, publicKeySpki } = args

  let clientData: { type?: unknown; challenge?: unknown }
  try {
    clientData = JSON.parse(new TextDecoder().decode(parts.clientDataJSON))
  } catch {
    throw new Error('Passkey assertion has malformed clientDataJSON.')
  }
  if (clientData.type !== 'webauthn.get') {
    throw new Error('Passkey assertion is not a webauthn.get ceremony.')
  }
  if (typeof clientData.challenge !== 'string' || clientData.challenge !== base64UrlEncode(expectedChallenge)) {
    throw new Error('Passkey assertion was not made over this payment (challenge mismatch).')
  }

  // authenticatorData = rpIdHash(32) | flags(1) | signCount(4) | ...
  if (parts.authenticatorData.length < 37) {
    throw new Error('Passkey assertion has truncated authenticator data.')
  }
  const flags = parts.authenticatorData[32]
  const UP = 0x01
  const UV = 0x04
  if ((flags & (UP | UV)) !== (UP | UV)) {
    throw new Error('Passkey assertion lacks user presence + user verification.')
  }

  const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', parts.clientDataJSON as BufferSource))
  const signed = new Uint8Array(parts.authenticatorData.length + clientDataHash.length)
  signed.set(parts.authenticatorData, 0)
  signed.set(clientDataHash, parts.authenticatorData.length)

  const key = await crypto.subtle.importKey(
    'spki',
    publicKeySpki as BufferSource,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    derToRawEcdsa(parts.signature) as BufferSource,
    signed as BufferSource,
  )
  if (!ok) throw new Error('Passkey assertion signature is invalid.')
}

/** Converts an ASN.1 DER ECDSA signature to the 64-byte r||s form Web Crypto wants. */
export function derToRawEcdsa(der: Uint8Array): Uint8Array {
  const fail = (): never => {
    throw new Error('Malformed DER ECDSA signature.')
  }
  let i = 0
  if (der[i++] !== 0x30) fail()
  let seqLen = der[i++]
  if (seqLen & 0x80) {
    const n = seqLen & 0x7f
    seqLen = 0
    for (let k = 0; k < n; k++) seqLen = (seqLen << 8) | der[i++]
  }
  if (seqLen !== der.length - i) fail()

  const readInt = (): Uint8Array => {
    if (der[i++] !== 0x02) fail()
    const len = der[i++]
    if (!len || i + len > der.length) fail()
    let bytes = der.slice(i, i + len)
    i += len
    while (bytes.length > 0 && bytes[0] === 0) bytes = bytes.slice(1)
    if (bytes.length > 32) fail()
    const out = new Uint8Array(32)
    out.set(bytes, 32 - bytes.length)
    return out
  }

  const r = readInt()
  const s = readInt()
  const raw = new Uint8Array(64)
  raw.set(r, 0)
  raw.set(s, 32)
  return raw
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlDecode(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
