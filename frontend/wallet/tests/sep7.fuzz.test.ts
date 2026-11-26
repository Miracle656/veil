// @stellar/stellar-sdk needs TextEncoder at module load; jsdom omits it.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import * as fc from 'fast-check'
import { parseSep7Uri, parseQrValue, buildSep7PayUri, buildStellarMemo, validateMemo } from '../lib/sep7'

describe('sep7 fuzz', () => {
  it('never throws on arbitrary unicode strings (10k runs)', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(() => parseSep7Uri(input)).not.toThrow()
        expect(() => parseQrValue(input)).not.toThrow()
      }),
      { numRuns: 10000 },
    )
  })

  it('never throws on URI-shaped strings (10k runs)', () => {
    const uriChars = fc.constantFrom(
      ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~:/?#[]@!$&\'()*+,;=%+'.split(''),
    )
    fc.assert(
      fc.property(fc.array(uriChars, { minLength: 0, maxLength: 200 }).map(cs => cs.join('')), (input) => {
        expect(() => parseSep7Uri(input)).not.toThrow()
        expect(() => parseQrValue(input)).not.toThrow()
      }),
      { numRuns: 10000 },
    )
  })

  it('never throws on strings with many special characters (10k runs)', () => {
    const specialChars = fc.constantFrom(
      ...' \t\n\r\x00\x01\x7f!@#$%^&*()_+-=[]{}|;:,.<>?/~`\'"\\'.split(''),
    )
    fc.assert(
      fc.property(
        fc.array(specialChars, { minLength: 0, maxLength: 200 }).map(cs => cs.join('')),
        (input) => {
          expect(() => parseSep7Uri(input)).not.toThrow()
          expect(() => parseQrValue(input)).not.toThrow()
        },
      ),
      { numRuns: 10000 },
    )
  })
})

describe('sep7 known-good examples', () => {
  // 56-char Stellar public keys (G... or C...) for lookLikeStellarAddress
  const PUBLIC_KEY = 'G67AK7IOO7UEJMXLT2S3PXRLSLLDCZBRZ2C7EJS3KBIO5TDD6YRMAMFS'
  const ISSUER = 'G7HBVM4YLL3DUXH7GQC63RAVIMU77YDAUTOMMTPVJ37ZO7WYLWLLLCUJ'

  it('parses a basic pay URI', () => {
    const uri = `web+stellar:pay?destination=${PUBLIC_KEY}&amount=100.50`
    const result = parseSep7Uri(uri)
    expect(result).not.toBeNull()
    expect(result!.destination).toBe(PUBLIC_KEY)
    expect(result!.amount).toBe('100.50')
  })

  it('parses a pay URI with asset info', () => {
    const uri = `web+stellar:pay?destination=${PUBLIC_KEY}&amount=100.50&asset_code=USD&asset_issuer=${ISSUER}`
    const result = parseSep7Uri(uri)
    expect(result).not.toBeNull()
    expect(result!.assetCode).toBe('USD')
    expect(result!.assetIssuer).toBe(ISSUER)
  })

  it('parses a URI with memo', () => {
    const uri = `web+stellar:pay?destination=${PUBLIC_KEY}&memo=test-memo`
    const result = parseSep7Uri(uri)
    expect(result).not.toBeNull()
    expect(result!.memo).toBe('test-memo')
    expect(result!.memoType).toBeUndefined()
  })

  it('parses a URI with memo and memo_type=MEMO_ID (exchange deposit)', () => {
    const uri = `web+stellar:pay?destination=${PUBLIC_KEY}&memo=123456789&memo_type=MEMO_ID`
    const result = parseSep7Uri(uri)
    expect(result).not.toBeNull()
    expect(result!.memo).toBe('123456789')
    expect(result!.memoType).toBe('MEMO_ID')
  })

  it('round-trips buildSep7PayUri with memo_type', () => {
    const uri = buildSep7PayUri({
      destination: PUBLIC_KEY,
      amount: '50',
      memo: '987654321',
      memoType: 'MEMO_ID',
    })
    const result = parseSep7Uri(uri)
    expect(result).not.toBeNull()
    expect(result!.memo).toBe('987654321')
    expect(result!.memoType).toBe('MEMO_ID')
  })

  it('parses a URI with encoded characters', () => {
    const uri = `web+stellar:pay?destination=${PUBLIC_KEY}&memo=${encodeURIComponent('hello world')}&amount=10`
    const result = parseSep7Uri(uri)
    expect(result).not.toBeNull()
    expect(result!.memo).toBe('hello world')
  })

  it('parses via parseQrValue', () => {
    const uri = `web+stellar:pay?destination=${PUBLIC_KEY}&amount=100.50`
    const result = parseQrValue(uri)
    expect(result).not.toBeNull()
    if (result && 'destination' in result) {
      expect(result.destination).toBe(PUBLIC_KEY)
    }
  })

  it('detects bare stellar address via parseQrValue', () => {
    const result = parseQrValue(PUBLIC_KEY)
    expect(result).not.toBeNull()
    if (result && 'destination' in result) {
      expect(result.destination).toBe(PUBLIC_KEY)
    }
  })

  it('detects C-prefix address via parseQrValue', () => {
    const cKey = 'C67AK7IOO7UEJMXLT2S3PXRLSLLDCZBRZ2C7EJS3KBIO5TDD6YRMAMFS'
    const result = parseQrValue(cKey)
    expect(result).not.toBeNull()
    if (result && 'destination' in result) {
      expect(result.destination).toBe(cKey)
    }
  })

  it('returns null for empty input', () => {
    expect(parseSep7Uri('')).toBeNull()
    expect(parseSep7Uri('   ')).toBeNull()
    expect(parseQrValue('')).toBeNull()
  })

  it('returns null for non-stellar URIs', () => {
    expect(parseSep7Uri('https://example.com')).toBeNull()
    expect(parseSep7Uri('bitcoin:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBeNull()
  })
})

describe('buildStellarMemo and validateMemo', () => {
  it('creates an ID memo for MEMO_ID', () => {
    const memo = buildStellarMemo('123456789', 'MEMO_ID')
    expect(memo).not.toBeNull()
    expect(memo?.type).toBe('id')
    expect(memo?.value).toBe('123456789')
  })

  it('creates an ID memo for lowercase "id"', () => {
    const memo = buildStellarMemo('9876543210', 'id')
    expect(memo).not.toBeNull()
    expect(memo?.type).toBe('id')
    expect(memo?.value).toBe('9876543210')
  })

  it('rejects a non-numeric string for MEMO_ID', () => {
    expect(() => buildStellarMemo('not-an-id', 'MEMO_ID')).toThrow(
      'ID memo must be an unsigned 64-bit integer.',
    )
  })

  it('rejects an ID memo exceeding uint64 max', () => {
    expect(() => buildStellarMemo('18446744073709551616', 'MEMO_ID')).toThrow(
      'ID memo exceeds 64-bit unsigned integer range.',
    )
  })

  it('creates a text memo when memo_type is MEMO_TEXT or omitted', () => {
    const m1 = buildStellarMemo('hello world', 'MEMO_TEXT')
    expect(m1?.type).toBe('text')
    expect(m1?.value).toBe('hello world')

    const m2 = buildStellarMemo('hello default')
    expect(m2?.type).toBe('text')
    expect(m2?.value).toBe('hello default')
  })

  it('rejects text memo exceeding 28 bytes', () => {
    const tooLong = 'a'.repeat(29)
    expect(() => buildStellarMemo(tooLong, 'MEMO_TEXT')).toThrow(
      'Text memo exceeds 28 bytes limit (29 bytes).',
    )
  })

  it('accepts text memo at exactly 28 bytes', () => {
    const exact = 'a'.repeat(28)
    const memo = buildStellarMemo(exact, 'text')
    expect(memo?.type).toBe('text')
  })

  it('rejects unsupported memo types', () => {
    expect(() => buildStellarMemo('test', 'UNKNOWN_TYPE')).toThrow(
      'Unsupported memo type: "UNKNOWN_TYPE".',
    )
  })

  it('returns null for empty memo input', () => {
    expect(buildStellarMemo('')).toBeNull()
    expect(buildStellarMemo('   ')).toBeNull()
  })

  it('validates memo correctly with validateMemo', () => {
    expect(validateMemo('')).toBeNull()
    expect(validateMemo('12345', 'MEMO_ID')).toBeNull()
    expect(validateMemo('valid text', 'MEMO_TEXT')).toBeNull()
    expect(validateMemo('a'.repeat(29), 'MEMO_TEXT')).toContain('exceeds 28 bytes')
    expect(validateMemo('abc', 'MEMO_ID')).toContain('unsigned 64-bit integer')
  })
})
