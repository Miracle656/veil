/**
 * Ed25519 CryptoNote-style stealth addresses with ERC-5564 view tags (scheme 0x0101)
 * for Stellar, gated behind `EXPO_PUBLIC_STEALTH_FEATURE_FLAG` (off by default).
 *
 * Reference implementation: https://github.com/shaibuafeez/stealth
 * Pinned commit: `faecde092149c21ee0d2cdfff17e04e538ba31e4`
 *
 * Security status: UNAUDITED. Underlying curve and hash primitives come from
 * audited `@noble/curves` and `@noble/hashes`, but the stealth construction and
 * raw-scalar signing (`signWithRawScalar`) have not undergone independent review,
 * and scheme ID `0x0101` is not yet assigned by any registry.
 *
 * See `docs/PRIVACY_THREAT_MODEL.md` §11 for the full threat model and the
 * criteria that must hold before this gate can default on.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { StrKey } from '@stellar/stellar-sdk';
import { assertStealthEnabled } from './config';

/** Unregistered provisional scheme ID from shaibuafeez/stealth. */
export const STEALTH_ED25519_SCHEME_ID = 0x0101;

/** Commit of shaibuafeez/stealth whose test vectors this module is checked against. */
export const STEALTH_REFERENCE_COMMIT = 'faecde092149c21ee0d2cdfff17e04e538ba31e4';

export const STELLAR_PUBLIC_NETWORK = 'Public Global Stellar Network ; September 2015';
export const STELLAR_TEST_NETWORK = 'Test SDF Network ; September 2015';

const L = ed25519.CURVE.n;
const Point = ed25519.ExtendedPoint;

const encoder = new TextEncoder();
const utf8 = (text: string): Uint8Array => encoder.encode(text);

const SECRET_LABEL = utf8('stealth:ed25519:secret');
const NONCE_LABEL = utf8('stealth:ed25519:nonce');
const ENVELOPE_TYPE_TX = new Uint8Array([0, 0, 0, 2]);
const STELLAR_META_PREFIX = 'st:stellar:0x';
const STELLAR_VIEW_KEY_PREFIX = 'stealth-view:stellar:0x';

export interface StealthKeyLabels {
  spending: string;
  viewing: string;
}

/** Reference labels from shaibuafeez/stealth (`KOVA_LABELS`) for vector parity. */
export const REFERENCE_STEALTH_LABELS: StealthKeyLabels = {
  spending: 'kova:stealth:spending',
  viewing: 'kova:stealth:viewing',
};

export interface StealthKeyMaterial {
  spending: Uint8Array;
  viewing: Uint8Array;
}

export interface StealthKeys {
  spendingPrivateKey: Uint8Array;
  viewingPrivateKey: Uint8Array;
}

export interface StealthMetaAddress {
  spendingPublicKey: Uint8Array;
  viewingPublicKey: Uint8Array;
}

export interface StealthViewKey {
  viewingPrivateKey: Uint8Array;
  spendingPublicKey: Uint8Array;
}

export interface StealthPayment {
  stealthAddress: string;
  stealthPublicKey: Uint8Array;
  ephemeralPublicKey: Uint8Array;
  viewTag: number;
}

export interface StealthAnnouncement {
  ephemeralPublicKey: Uint8Array;
  viewTag: number;
  stealthAddress?: string;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error('Invalid hex string');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function littleEndianToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    n = (n << 8n) | BigInt(bytes[i] as number);
  }
  return n;
}

function bigIntToLittleEndian(n: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let v = n;
  for (let i = 0; i < length; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Wide reduction of 64 hash bytes mod L (unbiased); rejects 0. */
function wideReduce(bytes: Uint8Array): bigint {
  const k = littleEndianToBigInt(bytes) % L;
  if (k === 0n) throw new Error('Degenerate ed25519 scalar');
  return k;
}

function assertValidScalar(privateKey: Uint8Array): bigint {
  if (privateKey.length !== 32) {
    throw new Error('An ed25519 scalar must be 32 bytes');
  }
  const k = littleEndianToBigInt(privateKey);
  if (k <= 0n || k >= L) {
    throw new Error('An ed25519 scalar must be in the range [1, L - 1]');
  }
  return k;
}

/**
 * Validates that `publicKey` is a canonical 32-byte Ed25519 point in the
 * prime-order subgroup:
 *   1. Exact 32-byte length
 *   2. Decodes as a valid twisted Edwards point (rejects non-decodable bytes)
 *   3. Not the identity point (0, 1) / `Point.ZERO`
 *   4. Torsion-free (`isTorsionFree()`), rejecting all small-order and
 *      mixed-order points
 *
 * Every public key input — meta-address spending/viewing keys, view-key
 * spending keys, and announcement ephemeral keys — passes through this check.
 */
export function assertValidEd25519PublicKey(publicKey: Uint8Array) {
  if (publicKey.length !== 32) {
    throw new Error('An ed25519 public key must be 32 bytes');
  }
  let point: ReturnType<typeof Point.fromHex>;
  try {
    point = Point.fromHex(publicKey);
  } catch {
    throw new Error('Ed25519 public key failed to decode as a valid curve point');
  }
  if (point.equals(Point.ZERO)) {
    throw new Error('Ed25519 public key must not be the identity point');
  }
  if (!point.isTorsionFree()) {
    throw new Error('Ed25519 public key is not in the prime-order subgroup (torsion point rejected)');
  }
  return point;
}

/** Derives a raw scalar private key from arbitrary secret material and a domain label. */
export function deriveEd25519PrivateKey(material: Uint8Array, label: string): Uint8Array {
  return bigIntToLittleEndian(wideReduce(sha512(concatBytes(material, utf8(label)))), 32);
}

/** Generates a random raw scalar private key using the platform CSPRNG. */
export function randomEd25519PrivateKey(): Uint8Array {
  return bigIntToLittleEndian(wideReduce(sha512(randomBytes(32))), 32);
}

/** Computes the 32-byte compressed Ed25519 public key `k * B` for raw scalar `k`. */
export function ed25519PublicKeyFromScalar(privateKey: Uint8Array): Uint8Array {
  const k = assertValidScalar(privateKey);
  return Point.BASE.multiply(k).toRawBytes();
}

/** Extracts spending/viewing key material from a deterministic 65-byte (r || s || v) signature. */
export function keyMaterialFromSignature(signature: Uint8Array): StealthKeyMaterial {
  if (signature.length !== 65) {
    throw new Error('Expected a 65-byte signature');
  }
  return {
    spending: signature.slice(0, 32),
    viewing: signature.slice(32, 64),
  };
}

/** Builds spending/viewing key material from a 32+ byte secret seed (e.g. WebAuthn PRF output). */
export function keyMaterialFromSeed(seed: Uint8Array): StealthKeyMaterial {
  if (seed.length < 32) {
    throw new Error('A stealth seed must be at least 32 bytes');
  }
  return { spending: seed, viewing: seed };
}

/** Derives spending and viewing raw scalar keys from secret material and labels. */
export function deriveStealthKeys(
  material: StealthKeyMaterial,
  labels: StealthKeyLabels = REFERENCE_STEALTH_LABELS
): StealthKeys {
  return {
    spendingPrivateKey: deriveEd25519PrivateKey(material.spending, labels.spending),
    viewingPrivateKey: deriveEd25519PrivateKey(material.viewing, labels.viewing),
  };
}

/** Encodes a Stellar stealth meta-address (`st:stellar:0x<spend><view>`). */
export function encodeStealthMetaAddress(meta: StealthMetaAddress): string {
  assertValidEd25519PublicKey(meta.spendingPublicKey);
  assertValidEd25519PublicKey(meta.viewingPublicKey);
  return `${STELLAR_META_PREFIX}${bytesToHex(concatBytes(meta.spendingPublicKey, meta.viewingPublicKey))}`;
}

/** Convenience helper to encode a meta-address directly from derived stealth keys. */
export function metaAddressFromKeys(keys: StealthKeys): string {
  return encodeStealthMetaAddress({
    spendingPublicKey: ed25519PublicKeyFromScalar(keys.spendingPrivateKey),
    viewingPublicKey: ed25519PublicKeyFromScalar(keys.viewingPrivateKey),
  });
}

/** Parses and strictly validates both public keys of a Stellar stealth meta-address. */
export function parseStealthMetaAddress(meta: string): StealthMetaAddress {
  if (!meta.startsWith(STELLAR_META_PREFIX) || meta.length !== STELLAR_META_PREFIX.length + 128) {
    throw new Error('Not a stellar stealth meta-address');
  }
  const raw = hexToBytes(meta.slice(STELLAR_META_PREFIX.length));
  const spendingPublicKey = raw.slice(0, 32);
  const viewingPublicKey = raw.slice(32, 64);
  assertValidEd25519PublicKey(spendingPublicKey);
  assertValidEd25519PublicKey(viewingPublicKey);
  return { spendingPublicKey, viewingPublicKey };
}

/** Builds a shareable view key (viewing private key + spending public key). */
export function viewKeyFromKeys(keys: StealthKeys): StealthViewKey {
  return {
    viewingPrivateKey: keys.viewingPrivateKey,
    spendingPublicKey: ed25519PublicKeyFromScalar(keys.spendingPrivateKey),
  };
}

/** Encodes a Stellar stealth view key (`stealth-view:stellar:0x<viewPriv><spendPub>`). */
export function encodeStealthViewKey(view: StealthViewKey): string {
  assertValidScalar(view.viewingPrivateKey);
  assertValidEd25519PublicKey(view.spendingPublicKey);
  return `${STELLAR_VIEW_KEY_PREFIX}${bytesToHex(concatBytes(view.viewingPrivateKey, view.spendingPublicKey))}`;
}

/** Parses and validates a Stellar stealth view key. */
export function parseStealthViewKey(text: string): StealthViewKey {
  if (!text.startsWith(STELLAR_VIEW_KEY_PREFIX) || text.length !== STELLAR_VIEW_KEY_PREFIX.length + 128) {
    throw new Error('Not a stellar stealth view key');
  }
  const raw = hexToBytes(text.slice(STELLAR_VIEW_KEY_PREFIX.length));
  const viewingPrivateKey = raw.slice(0, 32);
  const spendingPublicKey = raw.slice(32, 64);
  assertValidScalar(viewingPrivateKey);
  assertValidEd25519PublicKey(spendingPublicKey);
  return { viewingPrivateKey, spendingPublicKey };
}

/**
 * Computes the ECDH shared point `enc(privateKey * publicKey)`.
 *
 * Explicitly rejects non-decodable, identity (`Point.ZERO`), small-order, and
 * mixed-order points before scalar multiplication (closing the gap where
 * `Point.ZERO.isTorsionFree()` evaluates to `true`).
 */
export function computeSharedPoint(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const scalar = assertValidScalar(privateKey);
  const point = assertValidEd25519PublicKey(publicKey);
  const shared = point.multiply(scalar);
  if (shared.equals(Point.ZERO) || !shared.isTorsionFree()) {
    throw new Error('Degenerate shared point');
  }
  return shared.toRawBytes();
}

/** Hashes the 32-byte shared point to 64 bytes (`SHA-512(shared || "stealth:ed25519:secret")`). */
export function hashSharedSecret(sharedPoint: Uint8Array): Uint8Array {
  if (sharedPoint.length !== 32) {
    throw new Error('Shared point must be 32 bytes');
  }
  return sha512(concatBytes(sharedPoint, SECRET_LABEL));
}

/** Derives the one-time stealth public key `P = S + (H mod L) * B`. */
export function deriveStealthPublicKey(spendingPublicKey: Uint8Array, hashedSecret: Uint8Array): Uint8Array {
  const spendingPoint = assertValidEd25519PublicKey(spendingPublicKey);
  const tweak = wideReduce(hashedSecret);
  const stealthPoint = spendingPoint.add(Point.BASE.multiply(tweak));
  if (stealthPoint.equals(Point.ZERO) || !stealthPoint.isTorsionFree()) {
    throw new Error('Derived stealth public key is not in the prime-order subgroup');
  }
  return stealthPoint.toRawBytes();
}

/** Encodes a 32-byte Ed25519 public key as a Stellar `G...` StrKey address. */
export function stellarAddressFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error('A Stellar account id holds a 32-byte key');
  }
  return StrKey.encodeEd25519PublicKey(Buffer.from(publicKey));
}

/** Decodes a Stellar `G...` StrKey address to its 32-byte Ed25519 public key. */
export function stellarPublicKeyFromAddress(address: string): Uint8Array {
  if (!StrKey.isValidEd25519PublicKey(address)) {
    throw new Error('Not a valid Stellar account id (G...)');
  }
  return new Uint8Array(StrKey.decodeEd25519PublicKey(address));
}

/**
 * Stealth SEND entry point — gated behind `EXPO_PUBLIC_STEALTH_FEATURE_FLAG`.
 *
 * Derives a fresh one-time Stellar `G...` stealth address, ephemeral public key,
 * and 1-byte view tag for `metaAddress`. Throws `StealthFeatureDisabledError`
 * whenever the feature flag is off.
 */
export function createStealthPayment(
  metaAddress: string,
  options: { ephemeralPrivateKey?: Uint8Array } = {}
): StealthPayment {
  assertStealthEnabled('sending');
  const { spendingPublicKey, viewingPublicKey } = parseStealthMetaAddress(metaAddress);
  const ephemeral = options.ephemeralPrivateKey ?? randomEd25519PrivateKey();
  assertValidScalar(ephemeral);
  const shared = computeSharedPoint(ephemeral, viewingPublicKey);
  const hashed = hashSharedSecret(shared);
  const stealthPublicKey = deriveStealthPublicKey(spendingPublicKey, hashed);
  return {
    stealthAddress: stellarAddressFromPublicKey(stealthPublicKey),
    stealthPublicKey,
    ephemeralPublicKey: ed25519PublicKeyFromScalar(ephemeral),
    viewTag: hashed[0] as number,
  };
}

/**
 * Stealth RECEIVE (scan) entry point — gated behind `EXPO_PUBLIC_STEALTH_FEATURE_FLAG`.
 *
 * Checks whether an announcement belongs to `viewKey`. Rejects hostile
 * announcements carrying non-decodable, identity, or torsion ephemeral keys.
 * Returns the matched Stellar `G...` address or `null`.
 */
export function scanStealthAnnouncement(
  viewKey: StealthViewKey,
  announcement: StealthAnnouncement
): string | null {
  assertStealthEnabled('receiving');
  assertValidEd25519PublicKey(viewKey.spendingPublicKey);
  const shared = computeSharedPoint(viewKey.viewingPrivateKey, announcement.ephemeralPublicKey);
  const hashed = hashSharedSecret(shared);
  if (hashed[0] !== announcement.viewTag) return null;
  const stealthPublicKey = deriveStealthPublicKey(viewKey.spendingPublicKey, hashed);
  const address = stellarAddressFromPublicKey(stealthPublicKey);
  if (announcement.stealthAddress !== undefined) {
    const announcedBytes = stellarPublicKeyFromAddress(announcement.stealthAddress);
    if (!constantTimeEqual(stealthPublicKey, announcedBytes)) return null;
  }
  return address;
}

/**
 * Stealth RECEIVE (spending key derivation) entry point — gated behind
 * `EXPO_PUBLIC_STEALTH_FEATURE_FLAG`.
 *
 * Computes the one-time raw scalar private key `p = (s + (H mod L)) mod L`.
 */
export function deriveStealthPrivateKey(
  keys: StealthKeys,
  ephemeralPublicKey: Uint8Array
): Uint8Array {
  assertStealthEnabled('receiving');
  const spendingScalar = assertValidScalar(keys.spendingPrivateKey);
  const shared = computeSharedPoint(keys.viewingPrivateKey, ephemeralPublicKey);
  const hashed = hashSharedSecret(shared);
  const stealthScalar = (spendingScalar + wideReduce(hashed)) % L;
  if (stealthScalar === 0n) {
    throw new Error('Degenerate stealth private key');
  }
  return bigIntToLittleEndian(stealthScalar, 32);
}

/**
 * Ed25519 signature produced directly from a raw scalar private key (no RFC 8032 seed).
 * Nonce is deterministic from the scalar and message; verifies under standard RFC 8032.
 */
export function signWithRawScalar(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  const a = assertValidScalar(privateKey);
  const A = Point.BASE.multiply(a).toRawBytes();
  const prefix = sha512(concatBytes(NONCE_LABEL, privateKey)).slice(32);
  const r = littleEndianToBigInt(sha512(concatBytes(prefix, message))) % L;
  const R = Point.BASE.multiply(r).toRawBytes();
  const k = littleEndianToBigInt(sha512(concatBytes(R, A, message))) % L;
  return concatBytes(R, bigIntToLittleEndian((r + k * a) % L, 32));
}

/** Standard RFC 8032 Ed25519 signature verification. */
export function verifyEd25519Signature(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array
): boolean {
  return ed25519.verify(signature, message, publicKey);
}

/** Computes Stellar's transaction hash: SHA-256(SHA-256(networkPassphrase) || ENVELOPE_TYPE_TX || txXdr). */
export function stellarTransactionHash(networkPassphrase: string, transactionXdr: Uint8Array): Uint8Array {
  return sha256(concatBytes(sha256(utf8(networkPassphrase)), ENVELOPE_TYPE_TX, transactionXdr));
}

/**
 * Stealth SPEND (transaction signing) entry point — gated behind
 * `EXPO_PUBLIC_STEALTH_FEATURE_FLAG`.
 */
export function signStealthStellarTransaction(
  stealthPrivateKey: Uint8Array,
  networkPassphrase: string,
  transactionXdr: Uint8Array
): { hint: Uint8Array; signature: Uint8Array } {
  assertStealthEnabled('spending');
  const publicKey = ed25519PublicKeyFromScalar(stealthPrivateKey);
  return {
    hint: publicKey.slice(-4),
    signature: signWithRawScalar(stellarTransactionHash(networkPassphrase, transactionXdr), stealthPrivateKey),
  };
}
