import fc from 'fast-check'
import { buildSep7PayUri, parseQrValue, parseSep7Uri } from '../lib/sep7'

const DESTINATION = 'GBZXN7PIRZGNMHGAZFFWZVO6AOTQJ7WY4IQZQMGGFODTXPKVHG6VAO7M'
const ASSET_ISSUER = 'GA5ZSEJYB37RCUFJOODVY42EGKBGGXNVP63PRVRVYUI6D63CK6GJ5B77'

const queryKey = fc.constantFrom(
  'destination',
  'amount',
  'asset_code',
  'asset_issuer',
  'memo',
  'unused'
)

const queryString = fc
  .dictionary(queryKey, fc.string({ maxLength: 40 }), { maxKeys: 6 })
  .map((values) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(values)) {
      params.set(key, value)
    }
    return params.toString()
  })

const uriLikeString = fc.oneof(
  fc.string({ maxLength: 256 }),
  queryString.map((query) => `web+stellar:pay?${query}`),
  queryString.map((query) => `WEB+STELLAR:pay?${query}`),
  queryString.map((query) => `web+stellar://pay?${query}`)
)

describe('SEP-7 parsing fuzz coverage', () => {
  it('never throws for arbitrary URI-shaped input', () => {
    const start = Date.now()

    fc.assert(
      fc.property(uriLikeString, (input) => {
        const parsed = parseSep7Uri(input)
        const qrParsed = parseQrValue(input)

        expect(parsed === null || typeof parsed === 'object').toBe(true)
        expect(qrParsed === null || typeof qrParsed === 'object').toBe(true)
      }),
      { numRuns: 10000 }
    )

    expect(Date.now() - start).toBeLessThan(30000)
  })

  it('still parses known-good payment examples', () => {
    const uri = buildSep7PayUri({
      destination: DESTINATION,
      amount: '12.50',
      assetCode: 'USDC',
      assetIssuer: ASSET_ISSUER,
      memo: 'invoice-42',
    })

    expect(parseSep7Uri(uri)).toEqual({
      destination: DESTINATION,
      amount: '12.50',
      assetCode: 'USDC',
      assetIssuer: ASSET_ISSUER,
      memo: 'invoice-42',
    })
  })
})
