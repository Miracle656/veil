/**
 * @jest-environment node
 */

/**
 * The stealth scheme, checked from both ends.
 *
 * The sender and the holder compute the same hash by different routes —
 * `SHA-256(r·V ‖ R)` against `SHA-256(v·R ‖ R)` — so deriving as each and
 * comparing the addresses is a real check of the arithmetic rather than a
 * snapshot of whatever the code happened to produce.
 */

import {
  META_ADDRESS_PREFIX,
  StealthAddressError,
  bytesToHex,
  deriveStealthAddress,
  deriveStealthSecret,
  encodeMetaAddress,
  metaAddressFromSecrets,
  parseMetaAddress,
} from '../stealthAddress'

/** A scalar a handful of bytes wide, so the byte order is not masked by zeros. */
function scalar(...tail: number[]): Uint8Array {
  const out = new Uint8Array(32)
  out.set(tail, 32 - tail.length)
  return out
}

const spendSecret = scalar(0x11, 0x22, 0x33)
const viewSecret = scalar(0x44, 0x55, 0x66)
const ephemeralSecret = scalar(0x77, 0x88, 0x99)

describe('meta-address encoding', () => {
  const meta = metaAddressFromSecrets(spendSecret, viewSecret)

  it('is the two public keys, spend first, as hex', () => {
    const encoded = encodeMetaAddress(meta)
    expect(encoded.startsWith(META_ADDRESS_PREFIX)).toBe(true)
    expect(encoded).toBe(
      `${META_ADDRESS_PREFIX}${bytesToHex(meta.spendKey)}${bytesToHex(meta.viewKey)}`,
    )
  })

  it('round-trips', () => {
    const parsed = parseMetaAddress(encodeMetaAddress(meta))
    expect(bytesToHex(parsed.spendKey)).toBe(bytesToHex(meta.spendKey))
    expect(bytesToHex(parsed.viewKey)).toBe(bytesToHex(meta.viewKey))
  })

  it('tolerates surrounding whitespace from a paste', () => {
    expect(() => parseMetaAddress(`  ${encodeMetaAddress(meta)}\n`)).not.toThrow()
  })

  it('refuses a string that is not a meta-address', () => {
    expect(() => parseMetaAddress('ada*useveilapp.xyz')).toThrow(StealthAddressError)
    expect(() => parseMetaAddress(`0x${bytesToHex(meta.spendKey)}`)).toThrow(StealthAddressError)
  })

  it('refuses the wrong number of bytes', () => {
    // One key is not a meta-address: a sender would otherwise need a second
    // string and could be handed the wrong one of the pair.
    expect(() => parseMetaAddress(`${META_ADDRESS_PREFIX}${bytesToHex(meta.spendKey)}`)).toThrow(
      /two 32-byte keys/,
    )
  })

  it('refuses 32 bytes that are not a curve point', () => {
    // All 0xff is not a valid compressed Ed25519 point. It is still 32 bytes,
    // which is why length alone cannot be the check.
    expect(() =>
      parseMetaAddress(`${META_ADDRESS_PREFIX}${'ff'.repeat(32)}${'00'.repeat(32)}`),
    ).toThrow(/not a valid Ed25519 public key/)
  })
})

describe('deriving a one-time address', () => {
  const meta = metaAddressFromSecrets(spendSecret, viewSecret)

  it('produces a G… address, never the name’s contract address', () => {
    const payment = deriveStealthAddress(meta, { ephemeralSecret })
    expect(payment.oneTimeAddress.startsWith('G')).toBe(true)
    expect(payment.oneTimeAddress).toHaveLength(56)
    expect(payment.ephemeralPublicKey).toHaveLength(64)
  })

  it('is stable for one ephemeral secret and different for another', () => {
    // Reusing an ephemeral secret links two payments to one address, which is
    // what the scheme exists to avoid; a new one must move.
    const first = deriveStealthAddress(meta, { ephemeralSecret })
    const again = deriveStealthAddress(meta, { ephemeralSecret })
    const other = deriveStealthAddress(meta, { ephemeralSecret: scalar(0xaa, 0xbb, 0xcc) })

    expect(again.oneTimeAddress).toBe(first.oneTimeAddress)
    expect(again.ephemeralPublicKey).toBe(first.ephemeralPublicKey)
    expect(other.oneTimeAddress).not.toBe(first.oneTimeAddress)
  })

  it('gives two names with different view keys different addresses', () => {
    const otherMeta = metaAddressFromSecrets(spendSecret, scalar(0x01, 0x02, 0x03))
    const a = deriveStealthAddress(meta, { ephemeralSecret })
    const b = deriveStealthAddress(otherMeta, { ephemeralSecret })
    expect(a.oneTimeAddress).not.toBe(b.oneTimeAddress)
  })

  it('can be reproduced by the holder from the spend key and R', () => {
    const payment = deriveStealthAddress(meta, { ephemeralSecret })
    const secret = deriveStealthSecret(spendSecret, viewSecret, payment.ephemeralPublicKey)

    expect(secret.oneTimeAddress).toBe(payment.oneTimeAddress)
    expect(secret.secretScalar).toHaveLength(64)
  })

  it('refuses a point that is not on the curve', () => {
    expect(() =>
      deriveStealthAddress(
        { spendKey: new Uint8Array(32).fill(0xff), viewKey: meta.viewKey },
        { ephemeralSecret },
      ),
    ).toThrow(StealthAddressError)
  })

  it('refuses an all-zero ephemeral secret', () => {
    // Zero times G is the identity, so R would leak and the shared point would
    // say nothing about the sender's secret.
    expect(() => deriveStealthAddress(meta, { ephemeralSecret: new Uint8Array(32) })).toThrow(
      /must not be zero/,
    )
  })

  it('refuses a zero spend or view secret when building a meta-address', () => {
    expect(() => metaAddressFromSecrets(new Uint8Array(32), viewSecret)).toThrow(/must not be zero/)
    expect(() => metaAddressFromSecrets(spendSecret, new Uint8Array(32))).toThrow(/must not be zero/)
  })
})
