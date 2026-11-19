/**
 * @jest-environment jsdom
 *
 * Issue #1325 — default-off gate, hostile-input point validation (identity,
 * non-decodable, small-order, and mixed-order), and normative reference test
 * vectors for ed25519 stealth addresses (scheme 0x0101).
 *
 * Reference implementation: https://github.com/shaibuafeez/stealth
 * Pinned commit: `faecde092149c21ee0d2cdfff17e04e538ba31e4`
 */

import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
  writable: true,
})
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { ed25519 } from '@noble/curves/ed25519'
import {
  STEALTH_FEATURE_FLAG,
  StealthFeatureDisabledError,
  assertStealthEnabled,
  isStealthEnabled,
} from '../config'
import {
  REFERENCE_STEALTH_LABELS,
  STEALTH_ED25519_SCHEME_ID,
  STEALTH_REFERENCE_COMMIT,
  STELLAR_TEST_NETWORK,
  assertValidEd25519PublicKey,
  bytesToHex,
  computeSharedPoint,
  createStealthPayment,
  deriveStealthKeys,
  deriveStealthPrivateKey,
  deriveStealthPublicKey,
  ed25519PublicKeyFromScalar,
  encodeStealthViewKey,
  hashSharedSecret,
  hexToBytes,
  keyMaterialFromSeed,
  keyMaterialFromSignature,
  metaAddressFromKeys,
  parseStealthMetaAddress,
  parseStealthViewKey,
  scanStealthAnnouncement,
  signStealthStellarTransaction,
  stellarTransactionHash,
  verifyEd25519Signature,
  viewKeyFromKeys,
} from '../stealth'

/**
 * Normative Stellar vector copied verbatim from
 * `shaibuafeez/stealth` `test/vectors/stealth-v1.json` at commit
 * `faecde092149c21ee0d2cdfff17e04e538ba31e4`.
 */
const REFERENCE_STELLAR_VECTOR = {
  signature:
    '111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222221b',
  ephemeralPrivateKey: 'eeeb226449a3e75c2e7b474cd0b1dc294f10888dbc7b436b492359a8fce6d502',
  spendingPrivateKey: 'bc5ae3cbc0070d998108915cfbabb0dd4590ea8c05eb1fbee043c4bdd3a4f609',
  viewingPrivateKey: 'c7c595f5f4e43fabb17c5236ea5cff7dfb0b325cf5237de3608fe98af249250c',
  metaAddress:
    'st:stellar:0xf57cf1c93fb17d50fce5771d21e242511a3badb8d42037f4798c3bcf542ad39ba368a06f1b8c9581b1f9f6c7030212e2be7bc679362f7da3bdf3575c62e2f9a2',
  viewKey:
    'stealth-view:stellar:0xc7c595f5f4e43fabb17c5236ea5cff7dfb0b325cf5237de3608fe98af249250cf57cf1c93fb17d50fce5771d21e242511a3badb8d42037f4798c3bcf542ad39b',
  stealthAddress: 'GB4CMZAIQ4SKEANSBZUBRXDZBT5T5FU2ZFNOS554NQI5MV3HT2HNYSCO',
  ephemeralPublicKey: '64bcea70c645d4fa948c347af04760e809c27bc7958974ef21fe7c6804bd97b9',
  viewTag: 22,
  stealthPrivateKey: '2197451281057d04cecbeb0cf0eb2b9b65f50c726c346da0507a4930a42a5309',
} as const

// The Ed25519 identity point (0, 1), order 1.
const IDENTITY_POINT_HEX = '0100000000000000000000000000000000000000000000000000000000000000'

// All 7 non-identity points in Ed25519's 8-torsion subgroup.
const SMALL_ORDER_POINTS: ReadonlyArray<{ label: string; hex: string }> = [
  { label: 'order 2 (0, -1)', hex: 'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f' },
  { label: 'order 4 (+)', hex: '0000000000000000000000000000000000000000000000000000000000000000' },
  { label: 'order 4 (-)', hex: '0000000000000000000000000000000000000000000000000000000000000080' },
  { label: 'order 8 (#1)', hex: 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a' },
  { label: 'order 8 (#2)', hex: 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa' },
  { label: 'order 8 (#3)', hex: '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05' },
  { label: 'order 8 (#4)', hex: '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85' },
]

// Byte sequences that cannot decode to any point on Ed25519.
const NON_DECODABLE_POINTS: ReadonlyArray<{ label: string; hex: string }> = [
  { label: 'y = p (2^255 - 19, non-canonical)', hex: 'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f' },
  { label: 'y = p + 1', hex: 'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f' },
  { label: 'y = 2^255 - 1 (all ones)', hex: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f' },
  { label: 'y = 2 (no square root for x^2)', hex: '0200000000000000000000000000000000000000000000000000000000000000' },
  { label: 'y = 7 (no square root for x^2)', hex: '0700000000000000000000000000000000000000000000000000000000000000' },
]

beforeEach(() => {
  delete process.env[STEALTH_FEATURE_FLAG]
})

afterAll(() => {
  delete process.env[STEALTH_FEATURE_FLAG]
})

describe('stealth feature flag gate', () => {
  it('is off by default when NEXT_PUBLIC_STEALTH_FEATURE_FLAG is unset', () => {
    expect(isStealthEnabled()).toBe(false)
    expect(() => assertStealthEnabled('sending')).toThrow(StealthFeatureDisabledError)
  })

  it('stays off for non-opt-in values and turns on only for 1 or true', () => {
    for (const val of ['', '0', 'false', 'yes', 'TRUE', 'on']) {
      process.env[STEALTH_FEATURE_FLAG] = val
      expect(isStealthEnabled()).toBe(false)
    }

    process.env[STEALTH_FEATURE_FLAG] = '1'
    expect(isStealthEnabled()).toBe(true)

    process.env[STEALTH_FEATURE_FLAG] = 'true'
    expect(isStealthEnabled()).toBe(true)
  })

  it('blocks stealth sending, scanning, key derivation, and signing while off', () => {
    const keys = deriveStealthKeys(keyMaterialFromSignature(hexToBytes(REFERENCE_STELLAR_VECTOR.signature)))
    const view = viewKeyFromKeys(keys)
    const ephemeralPub = hexToBytes(REFERENCE_STELLAR_VECTOR.ephemeralPublicKey)
    const stealthPriv = hexToBytes(REFERENCE_STELLAR_VECTOR.stealthPrivateKey)

    expect(() => createStealthPayment(REFERENCE_STELLAR_VECTOR.metaAddress)).toThrow(
      StealthFeatureDisabledError
    )
    expect(() =>
      scanStealthAnnouncement(view, {
        ephemeralPublicKey: ephemeralPub,
        viewTag: REFERENCE_STELLAR_VECTOR.viewTag,
        stealthAddress: REFERENCE_STELLAR_VECTOR.stealthAddress,
      })
    ).toThrow(StealthFeatureDisabledError)
    expect(() => deriveStealthPrivateKey(keys, ephemeralPub)).toThrow(StealthFeatureDisabledError)
    expect(() =>
      signStealthStellarTransaction(stealthPriv, STELLAR_TEST_NETWORK, new TextEncoder().encode('tx'))
    ).toThrow(StealthFeatureDisabledError)
  })
})

describe('normative reference test vectors (shaibuafeez/stealth@faecde09)', () => {
  beforeEach(() => {
    process.env[STEALTH_FEATURE_FLAG] = '1'
  })

  it('pins scheme ID 0x0101 and reference commit faecde092149c21ee0d2cdfff17e04e538ba31e4', () => {
    expect(STEALTH_ED25519_SCHEME_ID).toBe(0x0101)
    expect(STEALTH_REFERENCE_COMMIT).toBe('faecde092149c21ee0d2cdfff17e04e538ba31e4')
  })

  it('reproduces every Stellar output in test/vectors/stealth-v1.json byte for byte', () => {
    const material = keyMaterialFromSignature(hexToBytes(REFERENCE_STELLAR_VECTOR.signature))
    const keys = deriveStealthKeys(material, REFERENCE_STEALTH_LABELS)

    expect(bytesToHex(keys.spendingPrivateKey)).toBe(REFERENCE_STELLAR_VECTOR.spendingPrivateKey)
    expect(bytesToHex(keys.viewingPrivateKey)).toBe(REFERENCE_STELLAR_VECTOR.viewingPrivateKey)

    const meta = metaAddressFromKeys(keys)
    expect(meta).toBe(REFERENCE_STELLAR_VECTOR.metaAddress)

    const view = viewKeyFromKeys(keys)
    const encodedView = encodeStealthViewKey(view)
    expect(encodedView).toBe(REFERENCE_STELLAR_VECTOR.viewKey)
    expect(parseStealthViewKey(encodedView)).toEqual(view)

    const payment = createStealthPayment(meta, {
      ephemeralPrivateKey: hexToBytes(REFERENCE_STELLAR_VECTOR.ephemeralPrivateKey),
    })
    expect(payment.stealthAddress).toBe(REFERENCE_STELLAR_VECTOR.stealthAddress)
    expect(bytesToHex(payment.ephemeralPublicKey)).toBe(REFERENCE_STELLAR_VECTOR.ephemeralPublicKey)
    expect(payment.viewTag).toBe(REFERENCE_STELLAR_VECTOR.viewTag)

    const found = scanStealthAnnouncement(view, payment)
    expect(found).toBe(REFERENCE_STELLAR_VECTOR.stealthAddress)

    const derivedPriv = deriveStealthPrivateKey(keys, payment.ephemeralPublicKey)
    expect(bytesToHex(derivedPriv)).toBe(REFERENCE_STELLAR_VECTOR.stealthPrivateKey)
    expect(ed25519PublicKeyFromScalar(derivedPriv)).toEqual(payment.stealthPublicKey)
  })

  it('produces deterministic raw-scalar signatures that verify under standard RFC 8032 Ed25519', () => {
    const stealthPriv = hexToBytes(REFERENCE_STELLAR_VECTOR.stealthPrivateKey)
    const stealthPub = ed25519PublicKeyFromScalar(stealthPriv)
    const xdr = new TextEncoder().encode('stellar claimable balance claim tx xdr')

    const sig1 = signStealthStellarTransaction(stealthPriv, STELLAR_TEST_NETWORK, xdr)
    const sig2 = signStealthStellarTransaction(stealthPriv, STELLAR_TEST_NETWORK, xdr)

    expect(sig1.hint).toEqual(stealthPub.slice(-4))
    expect(sig1.signature).toEqual(sig2.signature)
    expect(
      verifyEd25519Signature(
        sig1.signature,
        stellarTransactionHash(STELLAR_TEST_NETWORK, xdr),
        stealthPub
      )
    ).toBe(true)
    expect(
      verifyEd25519Signature(
        sig1.signature,
        stellarTransactionHash(STELLAR_TEST_NETWORK, new TextEncoder().encode('tampered')),
        stealthPub
      )
    ).toBe(false)
  })

  it('keeps payments invisible to a different wallet seed', () => {
    const receiverKeys = deriveStealthKeys(keyMaterialFromSeed(new Uint8Array(32).fill(1)))
    const strangerKeys = deriveStealthKeys(keyMaterialFromSeed(new Uint8Array(32).fill(2)))
    const payment = createStealthPayment(metaAddressFromKeys(receiverKeys))

    expect(scanStealthAnnouncement(viewKeyFromKeys(receiverKeys), payment)).toBe(payment.stealthAddress)
    expect(scanStealthAnnouncement(viewKeyFromKeys(strangerKeys), payment)).toBeNull()
  })
})

describe('hostile-input point validation (identity, non-decodable, small-order, mixed-order)', () => {
  const keys = deriveStealthKeys(keyMaterialFromSeed(new Uint8Array(32).fill(7)))
  const view = viewKeyFromKeys(keys)
  const validPubHex = bytesToHex(ed25519PublicKeyFromScalar(keys.spendingPrivateKey))
  const validHashed = hashSharedSecret(
    computeSharedPoint(keys.viewingPrivateKey, ed25519PublicKeyFromScalar(keys.spendingPrivateKey))
  )

  beforeEach(() => {
    process.env[STEALTH_FEATURE_FLAG] = '1'
  })

  it('rejects wrong-length public keys (0, 31, and 33 bytes)', () => {
    expect(() => assertValidEd25519PublicKey(new Uint8Array(0))).toThrow()
    expect(() => assertValidEd25519PublicKey(new Uint8Array(31))).toThrow()
    expect(() => assertValidEd25519PublicKey(new Uint8Array(33))).toThrow()
  })

  it('rejects the Ed25519 identity point across every public-key and ECDH entry point', () => {
    const identity = hexToBytes(IDENTITY_POINT_HEX)

    expect(() => assertValidEd25519PublicKey(identity)).toThrow(/identity/i)
    expect(() => parseStealthMetaAddress(`st:stellar:0x${IDENTITY_POINT_HEX}${validPubHex}`)).toThrow(/identity/i)
    expect(() => parseStealthMetaAddress(`st:stellar:0x${validPubHex}${IDENTITY_POINT_HEX}`)).toThrow(/identity/i)
    expect(() =>
      parseStealthViewKey(`stealth-view:stellar:0x${bytesToHex(keys.viewingPrivateKey)}${IDENTITY_POINT_HEX}`)
    ).toThrow(/identity/i)
    expect(() => computeSharedPoint(keys.viewingPrivateKey, identity)).toThrow(/identity/i)
    expect(() => deriveStealthPublicKey(identity, validHashed)).toThrow(/identity/i)
    expect(() => createStealthPayment(`st:stellar:0x${validPubHex}${IDENTITY_POINT_HEX}`)).toThrow(/identity/i)
    expect(() =>
      scanStealthAnnouncement(view, { ephemeralPublicKey: identity, viewTag: 0 })
    ).toThrow(/identity/i)
    expect(() => deriveStealthPrivateKey(keys, identity)).toThrow(/identity/i)
  })

  it.each(NON_DECODABLE_POINTS)('rejects non-decodable point: $label', ({ hex }) => {
    const bad = hexToBytes(hex)

    expect(() => assertValidEd25519PublicKey(bad)).toThrow(/decode/i)
    expect(() => parseStealthMetaAddress(`st:stellar:0x${hex}${validPubHex}`)).toThrow(/decode/i)
    expect(() => parseStealthMetaAddress(`st:stellar:0x${validPubHex}${hex}`)).toThrow(/decode/i)
    expect(() => computeSharedPoint(keys.viewingPrivateKey, bad)).toThrow(/decode/i)
    expect(() => deriveStealthPublicKey(bad, validHashed)).toThrow(/decode/i)
    expect(() => createStealthPayment(`st:stellar:0x${validPubHex}${hex}`)).toThrow(/decode/i)
    expect(() => scanStealthAnnouncement(view, { ephemeralPublicKey: bad, viewTag: 0 })).toThrow(/decode/i)
    expect(() => deriveStealthPrivateKey(keys, bad)).toThrow(/decode/i)
  })

  it.each(SMALL_ORDER_POINTS)('rejects small-order torsion point: $label', ({ hex }) => {
    const small = hexToBytes(hex)

    expect(() => assertValidEd25519PublicKey(small)).toThrow(/prime-order|torsion/i)
    expect(() => parseStealthMetaAddress(`st:stellar:0x${hex}${validPubHex}`)).toThrow(/prime-order|torsion/i)
    expect(() => parseStealthMetaAddress(`st:stellar:0x${validPubHex}${hex}`)).toThrow(/prime-order|torsion/i)
    expect(() => computeSharedPoint(keys.viewingPrivateKey, small)).toThrow(/prime-order|torsion/i)
    expect(() => deriveStealthPublicKey(small, validHashed)).toThrow(/prime-order|torsion/i)
    expect(() => createStealthPayment(`st:stellar:0x${validPubHex}${hex}`)).toThrow(/prime-order|torsion/i)
    expect(() => scanStealthAnnouncement(view, { ephemeralPublicKey: small, viewTag: 0 })).toThrow(
      /prime-order|torsion/i
    )
    expect(() => deriveStealthPrivateKey(keys, small)).toThrow(/prime-order|torsion/i)
  })

  it.each(SMALL_ORDER_POINTS)(
    'rejects mixed-order point (prime-order base + $label)',
    ({ hex }) => {
      const mixed = ed25519.ExtendedPoint.BASE.add(ed25519.ExtendedPoint.fromHex(hex)).toRawBytes()
      const mixedHex = bytesToHex(mixed)

      expect(() => assertValidEd25519PublicKey(mixed)).toThrow(/prime-order|torsion/i)
      expect(() => parseStealthMetaAddress(`st:stellar:0x${validPubHex}${mixedHex}`)).toThrow(
        /prime-order|torsion/i
      )
      expect(() => computeSharedPoint(keys.viewingPrivateKey, mixed)).toThrow(/prime-order|torsion/i)
      expect(() =>
        scanStealthAnnouncement(view, { ephemeralPublicKey: mixed, viewTag: 0 })
      ).toThrow(/prime-order|torsion/i)
      expect(() => deriveStealthPrivateKey(keys, mixed)).toThrow(/prime-order|torsion/i)
    }
  )
})
