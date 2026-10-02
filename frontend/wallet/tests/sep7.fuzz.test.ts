import * as fc from 'fast-check'
import { parseSep7Uri, parseQrValue } from '../lib/sep7'

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
