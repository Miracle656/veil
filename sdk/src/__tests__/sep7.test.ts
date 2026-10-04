/**
 * Tests for the SEP-7 "pay" request builder/parser/validator.
 *
 * Covers builder↔parser round-trips, field normalisation, and safe rejection of
 * malformed and hostile inputs (bad addresses/amounts, oversized URIs, and
 * dangerous callback schemes).
 */

import { Asset, Networks } from '@stellar/stellar-sdk'
import {
  buildSep7PayUri,
  parseSep7PayUri,
  parseSep7QrValue,
  isValidDestination,
  Sep7Error,
  SEP7_SCHEME,
  MAX_SEP7_URI_LENGTH,
} from '../sep7'

// Real keys with valid StrKey checksums.
const DEST = 'GCSWM5I2FRYFIDSVJDGLWDH4TMQZY6IVT4JDF2SCFW6PPJ56TSBH23NO'
const ISSUER = 'GD2VUFNSFXBAVZEZIU6VRPFU2KMSU4VQKP65SCE4TR5C2MJPLJ6VEAIM'

describe('buildSep7PayUri', () => {
  it('builds a minimal pay URI', () => {
    const uri = buildSep7PayUri({ destination: DEST })
    expect(uri.startsWith(`${SEP7_SCHEME}pay?`)).toBe(true)
    expect(uri).toContain(`destination=${DEST}`)
  })

  it('includes amount, asset, memo, and callback', () => {
    const uri = buildSep7PayUri({
      destination: DEST,
      amount: '12.5',
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      memo: 'invoice-42',
      callback: 'https://merchant.example/cb',
    })
    expect(uri).toContain('amount=12.5')
    expect(uri).toContain('asset_code=USDC')
    expect(uri).toContain(`asset_issuer=${ISSUER}`)
    // Callback is prefixed with the SEP-7 `url:` token and percent-encoded.
    expect(uri).toContain('callback=url%3Ahttps%3A%2F%2Fmerchant.example%2Fcb')
  })

  it('omits the issuer for native XLM', () => {
    const uri = buildSep7PayUri({ destination: DEST, assetCode: 'XLM' })
    expect(uri).not.toContain('asset_code')
    expect(uri).not.toContain('asset_issuer')
  })

  it('rejects an invalid destination', () => {
    expect(() => buildSep7PayUri({ destination: 'not-an-address' })).toThrow(Sep7Error)
  })

  it('rejects a non-native asset without an issuer', () => {
    expect(() => buildSep7PayUri({ destination: DEST, assetCode: 'USDC' })).toThrow(/issuer/)
  })

  it.each(['-1', '0', 'abc', '1e3', '1.234567890', '1.2.3', 'Infinity'])(
    'rejects invalid amount "%s"',
    (amount) => {
      expect(() => buildSep7PayUri({ destination: DEST, amount })).toThrow(Sep7Error)
    },
  )

  it('rejects an oversized text memo', () => {
    expect(() => buildSep7PayUri({ destination: DEST, memo: 'x'.repeat(29) })).toThrow(/28 bytes/)
  })

  it('rejects a hostile callback scheme', () => {
    expect(() =>
      buildSep7PayUri({ destination: DEST, callback: 'javascript:alert(1)' }),
    ).toThrow(/scheme/)
  })
})

describe('parseSep7PayUri', () => {
  it('parses and normalises a full request', () => {
    const uri = buildSep7PayUri({
      destination: DEST,
      amount: '12.5',
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      memo: 'invoice-42',
      callback: 'https://merchant.example/cb',
      msg: 'Thanks for your business',
    })
    const parsed = parseSep7PayUri(uri)
    expect(parsed).toEqual({
      destination: DEST,
      amount: '12.5',
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      memo: 'invoice-42',
      memoType: 'text',
      callback: 'https://merchant.example/cb',
      msg: 'Thanks for your business',
    })
  })

  it('decodes percent-encoded memo values', () => {
    const uri = buildSep7PayUri({ destination: DEST, memo: 'a b&c=d' })
    expect(parseSep7PayUri(uri).memo).toBe('a b&c=d')
  })

  it('parses an id memo with memo_type', () => {
    const uri = buildSep7PayUri({ destination: DEST, memo: '1234567890', memoType: 'id' })
    const parsed = parseSep7PayUri(uri)
    expect(parsed.memo).toBe('1234567890')
    expect(parsed.memoType).toBe('id')
  })

  describe('rejects malformed / hostile URIs', () => {
    it.each([
      ['wrong scheme', 'https://evil.example/pay?destination=' + DEST],
      ['unsupported op', `${SEP7_SCHEME}tx?xdr=AAAA`],
      ['missing destination', `${SEP7_SCHEME}pay?amount=1`],
      ['bad destination', `${SEP7_SCHEME}pay?destination=GINVALID`],
      ['bad amount', `${SEP7_SCHEME}pay?destination=${DEST}&amount=-5`],
      ['javascript callback', `${SEP7_SCHEME}pay?destination=${DEST}&callback=url%3Ajavascript%3Aalert(1)`],
      ['data callback', `${SEP7_SCHEME}pay?destination=${DEST}&callback=url%3Adata%3Atext%2Fhtml%2Cx`],
      ['issuer without code', `${SEP7_SCHEME}pay?destination=${DEST}&asset_issuer=${ISSUER}`],
      ['empty', ''],
    ])('%s', (_label, uri) => {
      expect(() => parseSep7PayUri(uri)).toThrow(Sep7Error)
    })

    it('rejects an oversized URI without heavy work', () => {
      const huge = `${SEP7_SCHEME}pay?destination=${DEST}&msg=` + 'a'.repeat(MAX_SEP7_URI_LENGTH)
      expect(() => parseSep7PayUri(huge)).toThrow(/maximum length/)
    })
  })
})

describe('round-trip', () => {
  it('build → parse preserves every field', () => {
    const params = {
      destination: DEST,
      amount: '999.9999999',
      assetCode: 'EURC',
      assetIssuer: ISSUER,
      memo: 'order #7',
      callback: 'https://shop.example/sep7/callback',
      msg: 'Order 7',
    }
    const parsed = parseSep7PayUri(buildSep7PayUri(params))
    expect(parsed.destination).toBe(params.destination)
    expect(parsed.amount).toBe(params.amount)
    expect(parsed.assetCode).toBe(params.assetCode)
    expect(parsed.assetIssuer).toBe(params.assetIssuer)
    expect(parsed.memo).toBe(params.memo)
    expect(parsed.callback).toBe(params.callback)
  })
})

describe('USDT0: the issuer is carried end to end (#791)', () => {
  const USDT0_ISSUER = 'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q'

  it('refuses a request for USDT0 that names no issuer', () => {
    expect(() => parseSep7PayUri(`${SEP7_SCHEME}pay?destination=${DEST}&asset_code=USDT0`))
      .toThrow(/asset_issuer is required/)
    expect(() => buildSep7PayUri({ destination: DEST, assetCode: 'USDT0' })).toThrow(Sep7Error)
  })

  it('keeps the issuer through build → QR → parse', () => {
    const uri = buildSep7PayUri({ destination: DEST, amount: '25', assetCode: 'USDT0', assetIssuer: USDT0_ISSUER })
    expect(uri).toContain(`asset_issuer=${USDT0_ISSUER}`)
    const parsed = parseSep7QrValue(uri)
    expect(parsed).toMatchObject({ assetCode: 'USDT0', assetIssuer: USDT0_ISSUER, amount: '25' })
  })

  it('derives the SAC from code:issuer rather than trusting a pasted one', () => {
    // Derived, then compared against the value checked on mainnet Horizon.
    expect(new Asset('USDT0', USDT0_ISSUER).contractId(Networks.PUBLIC))
      .toBe('CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF')
  })
})

describe('parseSep7QrValue', () => {
  it('treats a bare address as a destination-only request', () => {
    expect(parseSep7QrValue(DEST)).toEqual({ destination: DEST })
  })

  it('parses a SEP-7 URI', () => {
    const uri = buildSep7PayUri({ destination: DEST, amount: '5' })
    expect(parseSep7QrValue(uri).amount).toBe('5')
  })

  it('rejects junk', () => {
    expect(() => parseSep7QrValue('hello world')).toThrow(Sep7Error)
  })
})

describe('isValidDestination', () => {
  it('accepts G and C addresses, rejects others', () => {
    expect(isValidDestination(DEST)).toBe(true)
    expect(isValidDestination('GINVALID')).toBe(false)
    expect(isValidDestination('')).toBe(false)
  })
})
