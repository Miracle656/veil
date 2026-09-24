import {
  buildPortfolio,
  classifyAsset,
  type AssetKind,
} from '../portfolio'
import type { WalletAsset } from '@/lib/walletTypes'
import type { BlendPosition } from '@/lib/blend'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const USDY_ISSUER = 'GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6'

const xlm:  WalletAsset = { code: 'XLM',  issuer: null,        balance: '100' }
const usdc: WalletAsset = { code: 'USDC', issuer: USDC_ISSUER, balance: '50'  }
const usdy: WalletAsset = { code: 'USDY', issuer: USDY_ISSUER, balance: '25'  }

/** A minimal Blend position representing 10 USDC deposited. */
const blendPos: BlendPosition = {
  poolId:          'CPOOL',
  asset:           USDC_ISSUER,
  deposited:       '100000000', // 10 USDC in stroops
  bTokenBalance:   '100000000',
  accruedInterest: '0',
}

const NOW = 1_800_000_000_000

// ── classifyAsset ─────────────────────────────────────────────────────────────

describe('classifyAsset', () => {
  it.each([
    ['XLM',  null,        'cash'   as AssetKind],
    ['USDC', USDC_ISSUER, 'cash'   as AssetKind],
    ['USDY', USDY_ISSUER, 'invest' as AssetKind],
    ['EURC', null,        'cash'   as AssetKind],
    ['NGNC', null,        'cash'   as AssetKind],
    ['UNKN', null,        'cash'   as AssetKind], // unknown → conservative cash
  ] as [string, string | null, AssetKind][])('%s → %s', (code, issuer, expected) => {
    expect(classifyAsset(code, issuer)).toBe(expected)
  })
})

// ── buildPortfolio: empty wallet ──────────────────────────────────────────────

describe('buildPortfolio — empty portfolio', () => {
  it('returns null totals and an empty lines array', () => {
    const summary = buildPortfolio([], [], {}, NOW)
    expect(summary.lines).toHaveLength(0)
    expect(summary.totalUsd).toBeNull()
    expect(summary.cashUsd).toBeNull()
    expect(summary.lendingUsd).toBeNull()
    expect(summary.investUsd).toBeNull()
  })

  it('stores the supplied pricedAt timestamp', () => {
    const summary = buildPortfolio([], [], {}, NOW)
    expect(summary.pricedAt).toBe(NOW)
  })
})

// ── buildPortfolio: missing / stale price ─────────────────────────────────────

describe('buildPortfolio — missing price', () => {
  it('marks the line priceAvailable=false and valueUsd=null when price is absent from the map', () => {
    const summary = buildPortfolio([xlm], [], {}, NOW)
    const line = summary.lines[0]
    expect(line.valueUsd).toBeNull()
    expect(line.priceAvailable).toBe(false)
    expect(line.share).toBeNull()
  })

  it('does not contribute an unpriced asset to the total', () => {
    const usdcKey = `USDC:${USDC_ISSUER}`
    const summary = buildPortfolio([xlm, usdc], [], { [usdcKey]: 1.0 }, NOW)
    expect(summary.totalUsd).toBeCloseTo(50, 10)
    // XLM line is present but unpriced
    const xlmLine = summary.lines.find((l) => l.code === 'XLM')
    expect(xlmLine).toBeDefined()
    expect(xlmLine!.valueUsd).toBeNull()
  })

  it('shows unavailable for all assets when every price is null', () => {
    const prices: Record<string, number | null> = {
      XLM:                     null,
      ['USDC:' + USDC_ISSUER]: null,
    }
    const summary = buildPortfolio([xlm, usdc], [], prices, NOW)
    expect(summary.totalUsd).toBeNull()
    for (const line of summary.lines) {
      expect(line.valueUsd).toBeNull()
      expect(line.priceAvailable).toBe(false)
    }
  })

  it('returns totalUsd=null (not zero) when no asset has a price', () => {
    const summary = buildPortfolio([xlm], [], {}, NOW)
    expect(summary.totalUsd).toBeNull()
    expect(summary.totalUsd).not.toBe(0)
  })
})

// ── buildPortfolio: totals match sum of parts ─────────────────────────────────

describe('buildPortfolio — totals match parts', () => {
  it('totalUsd equals the sum of each line valueUsd', () => {
    const prices: Record<string, number | null> = {
      XLM:                     0.12,
      ['USDC:' + USDC_ISSUER]: 1.0,
      ['USDY:' + USDY_ISSUER]: 1.002,
    }
    const summary = buildPortfolio([xlm, usdc, usdy], [], prices, NOW)

    const expectedTotal = 100 * 0.12 + 50 * 1.0 + 25 * 1.002
    expect(summary.totalUsd).toBeCloseTo(expectedTotal, 10)

    const sumOfParts = summary.lines.reduce(
      (acc, l) => acc + (l.valueUsd ?? 0),
      0,
    )
    expect(sumOfParts).toBeCloseTo(summary.totalUsd as number, 10)
  })

  it('cashUsd + lendingUsd + investUsd equals totalUsd when every asset is priced', () => {
    const prices: Record<string, number | null> = {
      XLM:                     0.12,
      ['USDC:' + USDC_ISSUER]: 1.0,
      ['USDY:' + USDY_ISSUER]: 1.002,
      [USDC_ISSUER]:           1.0, // Blend position priced by contract key
    }
    const summary = buildPortfolio([xlm, usdc, usdy], [blendPos], prices, NOW)

    const bucketSum = (summary.cashUsd ?? 0) + (summary.lendingUsd ?? 0) + (summary.investUsd ?? 0)
    expect(bucketSum).toBeCloseTo(summary.totalUsd as number, 10)
  })

  it('share values sum to 1 when all assets are priced', () => {
    const prices: Record<string, number | null> = {
      XLM:                     0.12,
      ['USDC:' + USDC_ISSUER]: 1.0,
    }
    const summary = buildPortfolio([xlm, usdc], [], prices, NOW)
    const totalShare = summary.lines.reduce((acc, l) => acc + (l.share ?? 0), 0)
    expect(totalShare).toBeCloseTo(1, 10)
  })

  it('partial shares sum to less than 1 when some assets are unpriced', () => {
    const prices: Record<string, number | null> = {
      ['USDC:' + USDC_ISSUER]: 1.0,
      // XLM intentionally missing
    }
    const summary = buildPortfolio([xlm, usdc], [], prices, NOW)
    const totalShare = summary.lines.reduce((acc, l) => acc + (l.share ?? 0), 0)
    expect(totalShare).toBeCloseTo(1, 10)   // only USDC is priced → its share is 100% of the priced total
    const xlmLine = summary.lines.find((l) => l.code === 'XLM')
    expect(xlmLine!.share).toBeNull()
  })

  it('priced lines appear before unpriced lines in the sorted output', () => {
    const prices: Record<string, number | null> = { ['USDC:' + USDC_ISSUER]: 1.0 }
    const summary = buildPortfolio([xlm, usdc, usdy], [], prices, NOW)
    // Find index of the last priced line and first unpriced line
    let lastPricedIdx = -1
    let firstUnpricedIdx = summary.lines.length
    summary.lines.forEach((l, i) => {
      if (l.valueUsd !== null) lastPricedIdx = i
      else if (firstUnpricedIdx === summary.lines.length) firstUnpricedIdx = i
    })
    // All priced lines come before any unpriced line
    expect(firstUnpricedIdx).toBeGreaterThan(lastPricedIdx)
  })
})

// ── buildPortfolio: lending positions ─────────────────────────────────────────

describe('buildPortfolio — lending positions', () => {
  it('converts stroops to token units correctly (÷ 10_000_000)', () => {
    const summary = buildPortfolio([], [blendPos], {}, NOW)
    const line = summary.lines[0]
    expect(parseFloat(line.amount)).toBeCloseTo(10, 6)
  })

  it('assigns kind=lending to Blend positions', () => {
    const summary = buildPortfolio([], [blendPos], {}, NOW)
    expect(summary.lines[0].kind).toBe('lending')
  })

  it('prices lending positions via the contract-id key', () => {
    const prices = { [USDC_ISSUER]: 1.0 }
    const summary = buildPortfolio([], [blendPos], prices, NOW)
    const line = summary.lines[0]
    expect(line.valueUsd).toBeCloseTo(10, 6)
    expect(line.priceAvailable).toBe(true)
  })

  it('sets lendingUsd to null when the position price is unavailable', () => {
    const summary = buildPortfolio([], [blendPos], {}, NOW)
    expect(summary.lendingUsd).toBeNull()
  })
})

// ── buildPortfolio: zero balances filtered out ────────────────────────────────

describe('buildPortfolio — zero and negative balances', () => {
  it('excludes assets with a zero balance', () => {
    const zero: WalletAsset = { code: 'XLM', issuer: null, balance: '0' }
    const summary = buildPortfolio([zero], [], {}, NOW)
    expect(summary.lines).toHaveLength(0)
  })

  it('excludes assets with a non-numeric balance', () => {
    const bad: WalletAsset = { code: 'XLM', issuer: null, balance: 'NaN' }
    const summary = buildPortfolio([bad], [], {}, NOW)
    expect(summary.lines).toHaveLength(0)
  })
})
