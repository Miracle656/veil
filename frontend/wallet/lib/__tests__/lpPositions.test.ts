// react-dom/server & @stellar/stellar-sdk need TextEncoder at module load; jsdom omits it.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import fs from 'fs'
import path from 'path'
import * as React from 'react'
import { createElement } from 'react'
Object.assign(globalThis, { React })
import { renderToStaticMarkup } from 'react-dom/server'

import {
  collectLpPriceTargets,
  fetchHorizonLiquidityPool,
  filterPlainAssetBalances,
  formatPoolSharePct,
  formatUnderlyingValue,
  isLpShareBalance,
  loadLpPositions,
  parseLpShares,
  parsePoolReserveAsset,
  resolveLpPosition,
  resolveLpPositions,
  shortPoolId,
  type HorizonBalanceEntry,
  type HorizonLiquidityPoolRecord,
} from '../lpPositions'
import { buildPortfolio } from '../portfolio'
import { PortfolioSummary } from '@/components/PortfolioSummary'
import type { WalletAsset } from '@/lib/walletTypes'

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const AQUA_ISSUER = 'GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA'

const POOL_XLM_USDC = 'dd7b1ab831c273310ddbec6f97870aa83c2fbd78ce22aded37ecbf4f3380fac7'
const POOL_XLM_AQUA = 'aa1122334455667788990011223344556677889900112233445566778899aabb'
const POOL_UNKNOWN  = 'ff99887766554433221100ffeeddccbbaa99887766554433221100ffeeddccbb'

const XLM_USDC_RECORD: HorizonLiquidityPoolRecord = {
  id: POOL_XLM_USDC,
  fee_bp: 30,
  total_shares: '1000.0000000',
  total_trustlines: '42',
  reserves: [
    { asset: 'native', amount: '10000.0000000' },
    { asset: `USDC:${USDC_ISSUER}`, amount: '1000.0000000' },
  ],
}

const XLM_AQUA_RECORD: HorizonLiquidityPoolRecord = {
  id: POOL_XLM_AQUA,
  fee_bp: 30,
  total_shares: '2000.0000000',
  total_trustlines: '15',
  reserves: [
    { asset: 'native', amount: '4000.0000000' },
    { asset: `AQUA:${AQUA_ISSUER}`, amount: '400000.0000000' },
  ],
}

const NOW = 1_800_000_000_000

describe('LP position recognition and valuation', () => {
  // ── Held cases ────────────────────────────────────────────────────────────

  it('resolves a held LP position with pair, underlying amounts, pool share, and USD value', () => {
    const balances: HorizonBalanceEntry[] = [
      { asset_type: 'native', balance: '250.0000000' },
      { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, balance: '100.0000000' },
      { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_XLM_USDC, balance: '50.0000000' },
    ]
    const prices = {
      XLM: 0.1,
      [`USDC:${USDC_ISSUER}`]: 1.0,
    }

    const positions = resolveLpPositions(balances, { [POOL_XLM_USDC]: XLM_USDC_RECORD }, prices)
    expect(positions).toHaveLength(1)

    const pos = positions[0]
    expect(pos.status).toBe('known')
    expect(pos.poolId).toBe(POOL_XLM_USDC)
    expect(pos.pair).toBe('XLM / USDC')
    expect(pos.shares).toBe('50.0000000')
    expect(pos.totalShares).toBe('1000.0000000')
    expect(pos.shareOfPool).toBeCloseTo(0.05, 10)
    expect(pos.feeBp).toBe(30)

    expect(pos.underlying).not.toBeNull()
    expect(pos.underlying![0]).toMatchObject({
      code: 'XLM',
      issuer: null,
      priceKey: 'XLM',
      amount: '500.0000000',
    })
    expect(pos.underlying![0].valueUsd).toBeCloseTo(50, 10)
    expect(pos.underlying![1]).toMatchObject({
      code: 'USDC',
      issuer: USDC_ISSUER,
      priceKey: `USDC:${USDC_ISSUER}`,
      amount: '50.0000000',
    })
    expect(pos.underlying![1].valueUsd).toBeCloseTo(50, 10)
    expect(pos.valueUsd).toBeCloseTo(100, 10)
  })

  it('leaves valueUsd null when only one underlying leg is priced (never fabricates a partial USD value)', () => {
    const balances: HorizonBalanceEntry[] = [
      { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_XLM_USDC, balance: '50.0000000' },
    ]
    const prices = { XLM: 0.1 } // USDC missing

    const [pos] = resolveLpPositions(balances, { [POOL_XLM_USDC]: XLM_USDC_RECORD }, prices)
    expect(pos.status).toBe('known')
    expect(pos.pair).toBe('XLM / USDC')
    expect(pos.underlying![0].amount).toBe('500.0000000')
    expect(pos.underlying![1].amount).toBe('50.0000000')
    expect(pos.underlying![0].valueUsd).toBeCloseTo(50, 10)
    expect(pos.underlying![1].valueUsd).toBeNull()
    expect(pos.valueUsd).toBeNull()
  })

  it('sorts priced positions by valueUsd descending, then unpriced known, then unknown_pair', () => {
    const balances: HorizonBalanceEntry[] = [
      { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_UNKNOWN, balance: '10.0000000' },
      { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_XLM_AQUA, balance: '200.0000000' },
      { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_XLM_USDC, balance: '50.0000000' },
    ]
    const prices = { XLM: 0.1, [`USDC:${USDC_ISSUER}`]: 1.0 }
    const positions = resolveLpPositions(
      balances,
      { [POOL_XLM_USDC]: XLM_USDC_RECORD, [POOL_XLM_AQUA]: XLM_AQUA_RECORD },
      prices,
    )

    expect(positions.map((p) => p.poolId)).toEqual([POOL_XLM_USDC, POOL_XLM_AQUA, POOL_UNKNOWN])
  })

  // ── Zero cases ────────────────────────────────────────────────────────────

  it('ignores zero-share LP trustlines and returns an empty list when no LP shares are held', () => {
    const balances: HorizonBalanceEntry[] = [
      { asset_type: 'native', balance: '100.0000000' },
      { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_XLM_USDC, balance: '0.0000000' },
      { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_XLM_AQUA, balance: '0' },
      { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_UNKNOWN, balance: '-5' },
    ]

    expect(parseLpShares(balances)).toEqual([])
    expect(resolveLpPositions(balances, { [POOL_XLM_USDC]: XLM_USDC_RECORD })).toEqual([])
  })

  it('returns an empty list for a wallet holding only plain assets', () => {
    const balances: HorizonBalanceEntry[] = [
      { asset_type: 'native', balance: '500.0000000' },
      { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, balance: '25.0000000' },
    ]
    expect(resolveLpPositions(balances, {})).toEqual([])
  })

  // ── Unknown-pair cases ────────────────────────────────────────────────────

  it('reports an unknown_pair position when the pool record is unavailable', () => {
    const balances: HorizonBalanceEntry[] = [
      { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_UNKNOWN, balance: '12.5000000' },
    ]
    const positions = resolveLpPositions(balances, {})
    expect(positions).toHaveLength(1)
    expect(positions[0]).toEqual({
      poolId: POOL_UNKNOWN,
      shares: '12.5000000',
      totalShares: null,
      shareOfPool: null,
      feeBp: null,
      pair: 'Unknown pair',
      underlying: null,
      valueUsd: null,
      status: 'unknown_pair',
    })
  })

  it('reports unknown_pair when a pool record has malformed reserves or zero total_shares', () => {
    const brokenAssetRecord: HorizonLiquidityPoolRecord = {
      id: POOL_UNKNOWN,
      fee_bp: 30,
      total_shares: '100.0000000',
      reserves: [
        { asset: 'malformed-no-colon', amount: '100.0000000' },
        { asset: 'native', amount: '100.0000000' },
      ],
    }
    const zeroTotalSharesRecord: HorizonLiquidityPoolRecord = {
      id: POOL_UNKNOWN,
      fee_bp: 30,
      total_shares: '0.0000000',
      reserves: [
        { asset: 'native', amount: '100.0000000' },
        { asset: `USDC:${USDC_ISSUER}`, amount: '100.0000000' },
      ],
    }

    expect(resolveLpPosition({ poolId: POOL_UNKNOWN, shares: '5' }, brokenAssetRecord).status).toBe('unknown_pair')
    expect(resolveLpPosition({ poolId: POOL_UNKNOWN, shares: '5' }, zeroTotalSharesRecord).status).toBe('unknown_pair')
    expect(parsePoolReserveAsset('not-a-valid-asset')).toBeNull()
  })

  // ── Separation: never summed into plain asset balances ────────────────────

  it('filterPlainAssetBalances excludes LP share entries so they never leak into plain balances', () => {
    const balances: HorizonBalanceEntry[] = [
      { asset_type: 'native', balance: '250.0000000' },
      { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, balance: '100.0000000' },
      { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_XLM_USDC, balance: '50.0000000' },
    ]

    expect(isLpShareBalance(balances[2])).toBe(true)
    expect(isLpShareBalance(balances[0])).toBe(false)

    const plain = filterPlainAssetBalances(balances)
    expect(plain).toHaveLength(2)
    expect(plain.every((b) => b.asset_type !== 'liquidity_pool_shares')).toBe(true)
  })

  it('buildPortfolio keeps LP positions separate and never sums them into plain XLM or USDC balances', () => {
    const plainAssets: WalletAsset[] = [
      { code: 'XLM', issuer: null, balance: '250.0000000' },
      { code: 'USDC', issuer: USDC_ISSUER, balance: '100.0000000' },
    ]
    const prices = { XLM: 0.1, [`USDC:${USDC_ISSUER}`]: 1.0 }
    const lpPositions = resolveLpPositions(
      [{ asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_XLM_USDC, balance: '50.0000000' }],
      { [POOL_XLM_USDC]: XLM_USDC_RECORD },
      prices,
    )

    const summary = buildPortfolio(plainAssets, [], prices, NOW, { lpPositions })

    // Plain XLM and USDC balances remain strictly 250 XLM ($25) and 100 USDC ($100) —
    // the LP position's 500 XLM and 50 USDC are NOT summed into them.
    const xlmLine = summary.lines.find((l) => l.code === 'XLM')
    const usdcLine = summary.lines.find((l) => l.code === 'USDC')
    expect(xlmLine?.amount).toBe('250.0000000')
    expect(xlmLine?.valueUsd).toBeCloseTo(25, 10)
    expect(usdcLine?.amount).toBe('100.0000000')
    expect(usdcLine?.valueUsd).toBeCloseTo(100, 10)
    expect(summary.cashUsd).toBeCloseTo(125, 10)

    // LP position is reported separately with its own total
    expect(summary.lpPositions).toHaveLength(1)
    expect(summary.lpUsd).toBeCloseTo(100, 10)
    expect(summary.totalUsd).toBeCloseTo(225, 10)
  })

  // ── Loader & helpers ──────────────────────────────────────────────────────

  it('loadLpPositions fetches missing pools, reuses knownPools, and degrades failed fetches to unknown_pair', async () => {
    const balances: HorizonBalanceEntry[] = [
      { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_XLM_USDC, balance: '50.0000000' },
      { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_UNKNOWN, balance: '10.0000000' },
    ]
    const fetchPool = jest.fn(async (id: string) => {
      if (id === POOL_UNKNOWN) throw new Error('Horizon 404')
      return null
    })

    const positions = await loadLpPositions(
      balances,
      fetchPool,
      { XLM: 0.1, [`USDC:${USDC_ISSUER}`]: 1.0 },
      { [POOL_XLM_USDC]: XLM_USDC_RECORD },
    )

    // XLM_USDC was in knownPools so fetchPool was only called for POOL_UNKNOWN
    expect(fetchPool).toHaveBeenCalledTimes(1)
    expect(fetchPool).toHaveBeenCalledWith(POOL_UNKNOWN)
    expect(positions).toHaveLength(2)
    expect(positions[0].status).toBe('known')
    expect(positions[1].status).toBe('unknown_pair')
  })

  it('fetchHorizonLiquidityPool returns null on non-OK status or network failure', async () => {
    const okFetch = jest.fn(async () => ({
      ok: true,
      json: async () => XLM_USDC_RECORD,
    })) as unknown as typeof fetch
    const notFoundFetch = jest.fn(async () => ({ ok: false })) as unknown as typeof fetch
    const failingFetch = jest.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch

    expect(await fetchHorizonLiquidityPool('https://horizon.stellar.org', POOL_XLM_USDC, okFetch)).toEqual(XLM_USDC_RECORD)
    expect(await fetchHorizonLiquidityPool('https://horizon.stellar.org', POOL_UNKNOWN, notFoundFetch)).toBeNull()
    expect(await fetchHorizonLiquidityPool('https://horizon.stellar.org', POOL_UNKNOWN, failingFetch)).toBeNull()
  })

  it('collectLpPriceTargets deduplicates underlying assets across positions', () => {
    const positions = resolveLpPositions(
      [
        { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_XLM_USDC, balance: '50' },
        { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_XLM_AQUA, balance: '100' },
      ],
      { [POOL_XLM_USDC]: XLM_USDC_RECORD, [POOL_XLM_AQUA]: XLM_AQUA_RECORD },
    )
    expect(collectLpPriceTargets(positions)).toEqual([
      { code: 'XLM', issuer: null },
      { code: 'AQUA', issuer: AQUA_ISSUER },
      { code: 'USDC', issuer: USDC_ISSUER },
    ])
  })

  it('formats pool share percentages, underlying values, and short pool IDs cleanly', () => {
    expect(formatPoolSharePct(0.05)).toBe('5.00%')
    expect(formatPoolSharePct(0.00001)).toBe('<0.01%')
    expect(formatPoolSharePct(null)).toBe('—')
    expect(shortPoolId(POOL_XLM_USDC)).toBe('dd7b1ab8…80fac7')

    const [known] = resolveLpPositions(
      [{ asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_XLM_USDC, balance: '50.0000000' }],
      { [POOL_XLM_USDC]: XLM_USDC_RECORD },
    )
    expect(formatUnderlyingValue(known)).toBe('500 XLM + 50 USDC')

    const [unknown] = resolveLpPositions(
      [{ asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_UNKNOWN, balance: '10.0000000' }],
      {},
    )
    expect(formatUnderlyingValue(unknown)).toBe('Underlying pair unavailable')
  })

  // ── UI rendering in PortfolioSummary ──────────────────────────────────────

  it('PortfolioSummary renders labelled LP positions with pair, underlying value, pool share, and unknown-pair fallback', () => {
    const prices = { XLM: 0.1, [`USDC:${USDC_ISSUER}`]: 1.0 }
    const lpPositions = resolveLpPositions(
      [
        { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_XLM_USDC, balance: '50.0000000' },
        { asset_type: 'liquidity_pool_shares', liquidity_pool_id: POOL_UNKNOWN, balance: '12.5000000' },
      ],
      { [POOL_XLM_USDC]: XLM_USDC_RECORD },
      prices,
    )
    const portfolio = buildPortfolio([], [], prices, NOW, { lpPositions })
    const html = renderToStaticMarkup(
      createElement(PortfolioSummary, {
        portfolio,
        currencyCode: 'USD',
        fxRate: 1,
      }),
    )

    expect(html).toContain('LP Positions')
    expect(html).toContain('LP Position')
    expect(html).toContain('XLM / USDC')
    expect(html).toContain('500 XLM + 50 USDC')
    expect(html).toContain('5.00% of pool')
    expect(html).toContain('$100.00')
    expect(html).toContain('Unknown pair')
    expect(html).toContain('Underlying pair unavailable')
  })

  // ── Web pools page placeholder audit ──────────────────────────────────────

  it('web pools page contains no hardcoded reserves, invented APRs, or fabricated share balances', () => {
    const poolsPagePath = path.resolve(__dirname, '../../app/pools/page.tsx')
    const source = fs.readFileSync(poolsPagePath, 'utf8')

    // Must fetch live pools from Horizon and use the shared LP positions module
    expect(source).toContain('/liquidity_pools')
    expect(source).toContain("from '@/lib/lpPositions'")

    // Must not contain hardcoded pool fixtures, invented APRs, or fabricated share counts
    expect(source).not.toMatch(/\bconst\s+POOLS\s*[:=]/)
    expect(source).not.toMatch(/\bapr\s*:\s*\d/)
    expect(source).not.toMatch(/\byourShares\s*:\s*\d/)
    expect(source).not.toMatch(/\breserveA\s*:\s*\d/)
    expect(source).not.toMatch(/\breserveB\s*:\s*\d/)
  })
})
