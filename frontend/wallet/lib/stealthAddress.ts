/**
 * Stealth payments: the sender's half of a meta-address.
 *
 * A Veil name resolves to a `C…` contract address, which a classic payment
 * cannot address at all. A stealth meta-address is the second record that
 * makes a name payable by anyone: two public keys, published by the holder,
 * from which each sender derives a fresh one-time address nobody else can link
 * to the name.
 *
 * ## The scheme
 *
 * A meta-address is `(S, V)`: an Ed25519 **spend** public key and **view**
 * public key. A sender:
 *
 *   1. invents an ephemeral scalar `r` and publishes `R = r·G` beside the
 *      payment, so the recipient can find it;
 *   2. computes the shared point `r·V` — only the holder of `v` can repeat it;
 *   3. hashes it, `h = SHA-256(r·V ‖ R)`, and takes `h mod L`;
 *   4. sends to `P = S + h·G`, a one-time Ed25519 public key.
 *
 * The holder computes the same `h` from `v·R`, then spends with the scalar
 * `s + h (mod L)`. Neither key alone is enough — `V` lets the holder scan for
 * payments, `S` lets them spend — which is the usual "view key / spend key"
 * split: a scanning service can be handed `v` without being able to move
 * funds.
 *
 * `R` is a 32-byte Ed25519 point and is returned in hex. It is not secret and
 * must travel with the payment; without it the recipient cannot derive `h`.
 *
 * ## What this module does not do
 *
 * It does not build or submit a payment. It derives the destination, and
 * refuses rather than guessing: a key that is not a valid Ed25519 point, or a
 * name with no published record, throws with a message the UI can show.
 */

import { ed25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha256'
import { StrKey } from '@stellar/stellar-sdk'

/** The text form of a meta-address: `st:vly:` then 64 bytes of hex. */
export const META_ADDRESS_PREFIX = 'st:vly:'

/** Each key is one compressed Ed25519 point. */
const KEY_BYTES = 32

/** The Ed25519 group order, `L`. Scalars live below it. */
const GROUP_ORDER = ed25519.CURVE.n

/** A refusal a screen can show verbatim. */
export class StealthAddressError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StealthAddressError'
  }
}

export interface StealthMetaAddress {
  /** The public key a one-time address is offset from. */
  spendKey: Uint8Array
  /** The public key a sender agrees a shared secret with. */
  viewKey: Uint8Array
}

/** What a sender needs to hand to a payment. */
export interface StealthPayment {
  /** The `G…` address to pay. Fresh for every derivation. */
  oneTimeAddress: string
  /** `R = r·G`, hex. Publish it with the payment so the holder can scan. */
  ephemeralPublicKey: string
}

/** What the holder keeps, in addition to the address. */
export interface StealthSecret {
  /** `(s + h) mod L`, hex. The scalar behind {@link oneTimeAddress}. */
  secretScalar: string
  /** The same one-time address the sender derived. */
  oneTimeAddress: string
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new StealthAddressError('Hex must be an even number of hexadecimal characters.')
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function bytesToScalar(bytes: Uint8Array): bigint {
  if (bytes.length !== KEY_BYTES) {
    throw new StealthAddressError('A stealth scalar must be 32 bytes.')
  }
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  return value % GROUP_ORDER
}

function scalarToBytes(scalar: bigint): Uint8Array {
  const out = new Uint8Array(KEY_BYTES)
  let value = ((scalar % GROUP_ORDER) + GROUP_ORDER) % GROUP_ORDER
  for (let i = KEY_BYTES - 1; i >= 0; i--) {
    out[i] = Number(value & 0xffn)
    value >>= 8n
  }
  return out
}

/**
 * A point from raw bytes, with a refusal instead of a low-level throw.
 *
 * An Ed25519 public key is a compressed curve point, not merely 32 bytes, so a
 * random string is not a meta-address. Failing here means the sender never
 * derives an address from a key that cannot have a matching secret.
 */
function pointFromBytes(bytes: Uint8Array, label: string) {
  if (bytes.length !== KEY_BYTES) {
    throw new StealthAddressError(`${label} must be 32 bytes.`)
  }
  try {
    return ed25519.ExtendedPoint.fromHex(bytes)
  } catch {
    throw new StealthAddressError(`${label} is not a valid Ed25519 public key.`)
  }
}

function validScalar(label: string, bytes: Uint8Array): bigint {
  const scalar = bytesToScalar(bytes)
  if (scalar === 0n) {
    throw new StealthAddressError(`${label} must not be zero.`)
  }
  return scalar
}

/** The shared hash `h = SHA-256(r·V ‖ R) mod L`, as the sender computes it. */
function senderOffset(meta: StealthMetaAddress, ephemeralScalar: bigint, ephemeralPublic: Uint8Array): bigint {
  const view = pointFromBytes(meta.viewKey, 'View key')
  const shared = view.multiply(ephemeralScalar).toRawBytes()
  const digest = sha256(concatBytes(shared, ephemeralPublic))
  let value = 0n
  for (const byte of digest) value = (value << 8n) | BigInt(byte)
  return value % GROUP_ORDER
}

/** The same hash `h`, as the holder computes it from `v·R`. */
function receiverOffset(viewSecret: bigint, ephemeralPublic: Uint8Array): bigint {
  const ephemeral = pointFromBytes(ephemeralPublic, 'Ephemeral public key')
  const shared = ephemeral.multiply(viewSecret).toRawBytes()
  const digest = sha256(concatBytes(shared, ephemeralPublic))
  let value = 0n
  for (const byte of digest) value = (value << 8n) | BigInt(byte)
  return value % GROUP_ORDER
}

function publicKeyBytes(point: { toRawBytes(): Uint8Array }): Uint8Array {
  return point.toRawBytes()
}

/** The `G…` address for a one-time public key. */
function addressFor(point: { toRawBytes(): Uint8Array }): string {
  return StrKey.encodeEd25519PublicKey(Buffer.from(publicKeyBytes(point)))
}

/**
 * The shareable form of a meta-address: `st:vly:` followed by the spend key
 * then the view key, each 32 bytes of lowercase hex.
 *
 * A single string rather than two fields because it is meant to be handed
 * around — pasted into a message, put in a profile, shown as a QR code — and
 * two values are two chances to swap them.
 */
export function encodeMetaAddress(meta: StealthMetaAddress): string {
  return `${META_ADDRESS_PREFIX}${bytesToHex(meta.spendKey)}${bytesToHex(meta.viewKey)}`
}

/**
 * Parse a meta-address, refusing anything that is not one.
 *
 * No trimming and no case folding of the prefix: this is a money destination,
 * and a string that merely looks like a meta-address is how funds go to a key
 * nobody holds. Surrounding whitespace is tolerated because pasting creates
 * it, but nothing inside is.
 */
export function parseMetaAddress(text: string): StealthMetaAddress {
  const trimmed = (text ?? '').trim()
  if (!trimmed.startsWith(META_ADDRESS_PREFIX)) {
    throw new StealthAddressError(`A meta-address starts with ${META_ADDRESS_PREFIX}.`)
  }
  const body = trimmed.slice(META_ADDRESS_PREFIX.length)
  if (body.length !== KEY_BYTES * 4) {
    throw new StealthAddressError(
      `A meta-address carries two 32-byte keys, so it is ${KEY_BYTES * 4} hex characters after ${META_ADDRESS_PREFIX}.`,
    )
  }
  const spendKey = hexToBytes(body.slice(0, KEY_BYTES * 2))
  const viewKey = hexToBytes(body.slice(KEY_BYTES * 2))
  // Reject non-points at parse time rather than when a sender is already
  // halfway through a payment.
  pointFromBytes(spendKey, 'Spend key')
  pointFromBytes(viewKey, 'View key')
  return { spendKey, viewKey }
}

/**
 * Build a meta-address from the two secrets its holder controls.
 *
 * Kept here so tests, the publishing flow and documentation all agree on how
 * the keys are encoded. The secrets are not returned: a caller that has them
 * already knows them.
 */
export function metaAddressFromSecrets(spendSecret: Uint8Array, viewSecret: Uint8Array): StealthMetaAddress {
  const spend = validScalar('Spend secret', spendSecret)
  const view = validScalar('View secret', viewSecret)
  return {
    spendKey: ed25519.ExtendedPoint.BASE.multiply(spend).toRawBytes(),
    viewKey: ed25519.ExtendedPoint.BASE.multiply(view).toRawBytes(),
  }
}

/**
 * Derive a one-time address a sender can pay.
 *
 * `ephemeralSecret` exists for tests and for a caller that wants to record the
 * scalar it used; a real payment must leave it undefined so a fresh one is
 * generated. Reusing a scalar links two payments to the same address, which is
 * the one thing this scheme exists to avoid.
 */
export function deriveStealthAddress(
  meta: StealthMetaAddress,
  options: { ephemeralSecret?: Uint8Array } = {},
): StealthPayment {
  const spend = pointFromBytes(meta.spendKey, 'Spend key')
  pointFromBytes(meta.viewKey, 'View key')

  const ephemeralSecret = options.ephemeralSecret ?? crypto.getRandomValues(new Uint8Array(KEY_BYTES))
  const r = validScalar('Ephemeral secret', ephemeralSecret)
  const ephemeralPoint = ed25519.ExtendedPoint.BASE.multiply(r)
  const ephemeralPublic = ephemeralPoint.toRawBytes()

  const offset = senderOffset(meta, r, ephemeralPublic)
  const oneTimePoint = spend.add(ed25519.ExtendedPoint.BASE.multiply(offset))

  return {
    oneTimeAddress: addressFor(oneTimePoint),
    ephemeralPublicKey: bytesToHex(ephemeralPublic),
  }
}

/**
 * The recipient's side: the secret behind a one-time address, from the spend
 * secret and the `R` the sender published.
 *
 * `spendSecret` is a 32-byte scalar, the one {@link metaAddressFromSecrets}
 * used — not an Ed25519 seed. This is what makes the scheme verifiable in a
 * test without a second implementation of the curve: derive as a sender, then
 * derive as the holder, and the two addresses must be equal.
 */
export function deriveStealthSecret(
  spendSecret: Uint8Array,
  viewSecret: Uint8Array,
  ephemeralPublicKey: string,
): StealthSecret {
  const spend = validScalar('Spend secret', spendSecret)
  const view = validScalar('View secret', viewSecret)
  const ephemeralPublic = hexToBytes(ephemeralPublicKey)
  pointFromBytes(ephemeralPublic, 'Ephemeral public key')

  const offset = receiverOffset(view, ephemeralPublic)
  const secret = (spend + offset) % GROUP_ORDER
  if (secret === 0n) {
    // Possible only for a pathological key pair; refusing beats publishing a
    // secret that spends to the identity.
    throw new StealthAddressError('The one-time secret is zero, so this meta-address cannot be used.')
  }
  const oneTimePoint = ed25519.ExtendedPoint.BASE.multiply(secret)

  return {
    secretScalar: bytesToHex(scalarToBytes(secret)),
    oneTimeAddress: addressFor(oneTimePoint),
  }
}
