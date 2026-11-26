/**
 * Cable TV and betting lookup clients, web side.
 *
 * These post to `/ngn/bills/lookup/{cabletv,betting}`, which wraith does not
 * implement — it has `GET /ngn/bills/data-bundles`, `POST /ngn/bills` and
 * `GET /ngn/bills/:orderId`, and `src/linq/bills.ts` carries no
 * customer-validation call to build the route from. Both categories are gated
 * to 'soon' on web and mobile until it exists.
 *
 * What is worth pinning meanwhile is the wire contract — the path and body the
 * route will have to match the day it is written.
 *
 * The original version asserted `expect(() => lookupCableTv(params))
 * .not.toThrow()`. These functions are async, so that could never throw
 * synchronously: it asserted nothing, and the rejection it left unhandled
 * crashed the jest worker outright.
 */

// @stellar/stellar-sdk needs TextEncoder at module load and jsdom omits it.
// Same two lines the other suites in this repo open with.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

// `ngn.ts` reads its base URL once at module load and refuses to call out at
// all when it is unset, so this has to be set before the first require — which
// a top-level import would be too late for.
process.env['NEXT_PUBLIC_WRAITH_URL'] = 'https://wraith.test'

/* eslint-disable @typescript-eslint/no-var-requires */
const { lookupCableTv, lookupBetting, isBillCategoryAvailable } = require('../ngn')

const originalFetch = global.fetch

/** Capture what the client sent, and reply with `body`. */
function mockFetch(body: unknown, ok = true, status = 200) {
  const spy = jest.fn().mockResolvedValue({
    ok,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response)
  global.fetch = spy as unknown as typeof fetch
  return spy
}

afterEach(() => {
  global.fetch = originalFetch
  jest.restoreAllMocks()
})

describe('the lookup clients exist', () => {
  it('exports a function for each lookup the bills page would call', () => {
    expect(typeof lookupCableTv).toBe('function')
    expect(typeof lookupBetting).toBe('function')
    expect(typeof isBillCategoryAvailable).toBe('function')
  })
})

describe('cable TV lookup', () => {
  const found = {
    customerName: 'John Doe',
    currentPackage: 'DSTV Compact',
    dueDate: '2026-11-15',
    availablePackages: [{ id: 'pkg1', name: 'DSTV Compact', price: 10500 }],
  }

  it('posts the smartcard to the agreed path and returns what came back', async () => {
    const spy = mockFetch(found)

    await expect(
      lookupCableTv({ provider: 'DSTV', smartcardNumber: '1234567890' }),
    ).resolves.toEqual(found)

    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toContain('/ngn/bills/lookup/cabletv')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      provider: 'DSTV',
      smartcardNumber: '1234567890',
    })
  })

  it('rejects rather than returning a half-answer when the lookup fails', async () => {
    // The page shows the customer's name before they spend. A failed lookup
    // that resolved would put an empty name in front of a payment.
    mockFetch({ error: 'Smartcard not found', code: 'not_found' }, false, 404)
    await expect(
      lookupCableTv({ provider: 'DSTV', smartcardNumber: '0000000000' }),
    ).rejects.toBeDefined()
  })
})

describe('betting lookup', () => {
  const found = { accountName: 'Jane Doe', accountStatus: 'active', balance: 2500 }

  it('posts the account id to the agreed path and returns what came back', async () => {
    const spy = mockFetch(found)

    await expect(lookupBetting({ provider: 'Bet9ja', accountId: 'ACC123' })).resolves.toEqual(
      found,
    )

    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toContain('/ngn/bills/lookup/betting')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ provider: 'Bet9ja', accountId: 'ACC123' })
  })

  it('rejects when the account cannot be verified', async () => {
    mockFetch({ error: 'Account not found', code: 'not_found' }, false, 404)
    await expect(lookupBetting({ provider: 'Bet9ja', accountId: 'nope' })).rejects.toBeDefined()
  })
})
