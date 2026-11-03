import { ASSET_REGISTRY } from '../assets'
import {
  ILLIQUID_REASON,
  LIQUIDITY_UNAVAILABLE_REASON,
  MIN_BOND_BOOK_DEPTH,
  assessBondLiquidity,
  fetchBondLiquidity,
  orderBookAssetType,
} from '../liquidity'

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

/** A slice of CETES's real USDC book (Horizon, mainnet). */
const CETES_BOOK = {
  bids: [{ price: '0.0645484', amount: '5500.6508106' }, { price: '0.0645162', amount: '53234.3834572' }],
  asks: [{ price: '0.0645511', amount: '0.4251501' }, { price: '0.0645807', amount: '79055.4257013' }],
}

/** KTB today: one bid and no asks. */
const KTB_BOOK = {
  bids: [{ price: '0.0007', amount: '100.0000000' }],
  asks: [] as Array<{ price: string; amount: string }>,
}

function response(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response
}

describe('assessBondLiquidity refuses a one-sided or empty book (#1062)', () => {
  it('passes a healthy two-sided book with depth', () => {
    const verdict = assessBondLiquidity(CETES_BOOK)
    expect(verdict.ok).toBe(true)
    if (verdict.ok) {
      expect(verdict.bidDepth).toBeGreaterThanOrEqual(MIN_BOND_BOOK_DEPTH)
      expect(verdict.askDepth).toBeGreaterThanOrEqual(MIN_BOND_BOOK_DEPTH)
    }
  })

  it('refuses a one-sided book and names illiquidity, not an error', () => {
    const verdict = assessBondLiquidity(KTB_BOOK)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.reason).toBe(ILLIQUID_REASON)
      expect(verdict.reason.toLowerCase()).toContain('one side')
    }
  })

  it('refuses a book with no asks and a book with no bids', () => {
    expect(assessBondLiquidity({ bids: [{ amount: '100' }], asks: [] }).ok).toBe(false)
    expect(assessBondLiquidity({ bids: [], asks: [{ amount: '100' }] }).ok).toBe(false)
  })

  it('refuses an empty book', () => {
    const verdict = assessBondLiquidity({ bids: [], asks: [] })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe(ILLIQUID_REASON)
  })

  it('refuses a two-sided book that is too thin to enter', () => {
    const verdict = assessBondLiquidity({ bids: [{ amount: '1' }], asks: [{ amount: '100' }] })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('too thin')
  })

  it('fails closed when the book cannot be read at all', () => {
    const verdict = assessBondLiquidity(null)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe(LIQUIDITY_UNAVAILABLE_REASON)
  })
})

describe('fetchBondLiquidity reads the live book and fails closed', () => {
  const deps = { horizonUrl: 'https://horizon.example', quoteIssuer: USDC_ISSUER }

  it('passes CETES, USTRY and TESOURO on their live books', async () => {
    for (const code of ['CETES', 'USTRY', 'TESOURO'] as const) {
      const asset = ASSET_REGISTRY[code]
      const fetchImpl = jest.fn(async () => response(CETES_BOOK))
      const verdict = await fetchBondLiquidity(asset, { ...deps, fetchImpl })
      expect(verdict.ok).toBe(true)
    }
  })

  it('refuses KTB, whose live book is one-sided', async () => {
    const fetchImpl = jest.fn(async () => response(KTB_BOOK))
    const verdict = await fetchBondLiquidity(ASSET_REGISTRY.KTB, { ...deps, fetchImpl })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe(ILLIQUID_REASON)
  })

  it('refuses the buy when the request throws', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('network down')
    })
    const verdict = await fetchBondLiquidity(ASSET_REGISTRY.CETES, { ...deps, fetchImpl })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe(LIQUIDITY_UNAVAILABLE_REASON)
  })

  it('refuses the buy on a non-2xx response', async () => {
    const fetchImpl = jest.fn(async () => response({}, false))
    const verdict = await fetchBondLiquidity(ASSET_REGISTRY.CETES, { ...deps, fetchImpl })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe(LIQUIDITY_UNAVAILABLE_REASON)
  })

  it('queries the long bond code as credit_alphanum12', async () => {
    const fetchImpl = jest.fn(async (_url: RequestInfo | URL) => response(CETES_BOOK))
    await fetchBondLiquidity(ASSET_REGISTRY.CETES, { ...deps, fetchImpl })
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('selling_asset_type=credit_alphanum12')
    expect(url).toContain('selling_asset_code=CETES')
    expect(url).toContain('buying_asset_type=credit_alphanum4')
  })

  it('derives the Horizon asset type from the code length', () => {
    expect(orderBookAssetType('USDC')).toBe('credit_alphanum4')
    expect(orderBookAssetType('CETES')).toBe('credit_alphanum12')
    expect(orderBookAssetType('TESOURO')).toBe('credit_alphanum12')
  })
})
