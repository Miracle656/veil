// @stellar/stellar-sdk is loaded (via ./network) at module import; jsdom omits
// TextEncoder, which the SDK needs at load time.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import {
  buildPortfolio,
  classifyAsset,
  type AssetKind,
} from '../portfolio'
import type { WalletAsset } from '@/lib/walletTypes'
import type { BlendPosition } from '@/lib/blend'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const USDC_TESTNET_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const USDY_ISSUER = 'GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6'
const USDT0_ISSUER = 'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q'
// The registry constants these must match are pinned by registryParity.test.ts.
const USDC_MAINNET_SAC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
const USDT0_MAINNET_SAC = 'CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF'
const FAKE_ISSUER = 'GCOUNTERFEITISSUERADDRESS0000000000000000000000000000000000000'

const xlm:  WalletAsset = { code: 'XLM',  issuer: null,        balance: '100' }
const usdc: WalletAsset = { code: 'USDC', issuer: USDC_ISSUER, balance: '50'  }
const usdy: WalletAsset = { code: 'USDY', issuer: USDY_ISSUER, balance: '25'  }

/** A minimal Blend position representing 10 USDC deposited, priced by SAC ID. */
const blendPos: BlendPosition = {
  poolId:          'CPOOL',
  asset:           USDC_MAINNET_SAC,
  deposited:       '100000000', // 10 USDC in stroops
  bTokenBalance:   '100000000',
  accruedInterest: '0',
}

const NOW = 1_800_000_000_000

// ── classifyAsset ─────────────────────────────────────────────────────────────

describe('classifyAsset', () => {
  it.each([
    ['XLM',  null,              'cash'   as AssetKind],
    ['USDC', USDC_ISSUER,       'cash'   as AssetKind],
    ['USDY', USDY_ISSUER,       'invest' as AssetKind],
    // A code is not an asset: same code, wrong issuer is NOT cash.
    ['USDC', FAKE_ISSUER,       'invest' as AssetKind],
    // Issuerless non-native codes are not verified dollars either.
    ['EURC', null,              'invest' as AssetKind],
    ['NGNC', null,              'invest' as AssetKind],
    ['UNKN', null,              'invest' as AssetKind], // unknown → invest, labelled unverified
    // Codes are case-sensitive: only the exact registered code verifies.
    ['usdc', USDC_ISSUER,       'invest' as AssetKind],
    ['USDC ', USDC_ISSUER,      'invest' as AssetKind],
  ] as [string, string | null, AssetKind][])('%s + issuer → %s', (code, issuer, expected) => {
    expect(classifyAsset(code, issuer)).toBe(expected)
  })

  it('verifies the testnet USDC issuer on testnet', () => {
    expect(classifyAsset('USDC', USDC_TESTNET_ISSUER, 'testnet')).toBe('cash')
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
  it('marks the line status=unavailable and valueUsd=null when price is absent from the map', () => {
    const summary = buildPortfolio([xlm], [], {}, NOW)
    const line = summary.lines[0]
    expect(line.valueUsd).toBeNull()
    expect(line.status).toBe('unavailable')
    expect(line.priceAvailable).toBe(false) // deprecated alias
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

  it('marks every line unavailable when all prices are null', () => {
    const prices: Record<string, number | null> = {
      XLM:                     null,
      ['USDC:' + USDC_ISSUER]: null,
    }
    const summary = buildPortfolio([xlm, usdc], [], prices, NOW)
    expect(summary.totalUsd).toBeNull()
    for (const line of summary.lines) {
      expect(line.valueUsd).toBeNull()
      expect(line.status).toBe('unavailable')
    }
  })

  it('returns totalUsd=null (not zero) when no asset has a price', () => {
    const summary = buildPortfolio([xlm], [], {}, NOW)
    expect(summary.totalUsd).toBeNull()
    expect(summary.totalUsd).not.toBe(0)
  })
})

// ── buildPortfolio: issuer-checked classification ────────────────────────────

describe('buildPortfolio — verified vs counterfeit assets', () => {
  it('buckets a verified USDC under cash and a counterfeit USDC under invest', () => {
    const counterfeit: WalletAsset = { code: 'USDC', issuer: FAKE_ISSUER, balance: '10' }
    const prices: Record<string, number | null> = {
      ['USDC:' + USDC_ISSUER]: 1.0,
      ['USDC:' + FAKE_ISSUER]: 1.0, // even at parity it is not a dollar
    }
    const summary = buildPortfolio([usdc, counterfeit], [], prices, NOW, { network: 'mainnet' })

    expect(summary.lines.find((l) => l.issuer === USDC_ISSUER)!.kind).toBe('cash')
    expect(summary.lines.find((l) => l.issuer === FAKE_ISSUER)!.kind).toBe('invest')
    expect(summary.lines.find((l) => l.issuer === FAKE_ISSUER)!.verification).toBe('unverified')
    // The counterfeit lands in invest, never in cash.
    const cashSum = summary.lines.filter((l) => l.kind === 'cash').reduce((s, l) => s + (l.valueUsd ?? 0), 0)
    expect(cashSum).toBeCloseTo(50, 10)
  })

  it('labels native XLM as native and registry assets as verified', () => {
    const summary = buildPortfolio([xlm, usdc, usdy], [], {}, NOW, { network: 'mainnet' })
    expect(summary.lines.find((l) => l.code === 'XLM')!.verification).toBe('native')
    expect(summary.lines.find((l) => l.code === 'USDC')!.verification).toBe('verified')
    expect(summary.lines.find((l) => l.code === 'USDY')!.verification).toBe('verified')
  })

  it('keeps real and impostor USDY distinct and identifies the registered issuer', () => {
    const counterfeit: WalletAsset = { code: 'USDY', issuer: FAKE_ISSUER, balance: '10' }
    const summary = buildPortfolio([usdy, counterfeit], [], {}, NOW, { network: 'mainnet' })

    expect(summary.lines.find((line) => line.issuer === USDY_ISSUER)?.verification).toBe('verified')
    expect(summary.lines.find((line) => line.issuer === FAKE_ISSUER)?.verification).toBe('unverified')
    expect(summary.lines).toHaveLength(2)
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
    }
    const summary = buildPortfolio([xlm, usdc, usdy], [blendPos], prices, NOW, { network: 'mainnet' })

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

  it('prices a USDC position through the verified SAC fallback', () => {
    const prices = { ['USDC:' + USDC_ISSUER]: 1.0 }
    const summary = buildPortfolio([], [blendPos], prices, NOW, { network: 'mainnet' })
    const line = summary.lines[0]
    expect(line.code).toBe('USDC')
    expect(line.issuer).toBe(USDC_ISSUER)
    expect(line.valueUsd).toBeCloseTo(10, 6)
    expect(summary.lendingUsd).toBeCloseTo(10, 6)
  })

  it('prices a position through an explicit, verified contractKeys map', () => {
    const usdt0Pos: BlendPosition = { ...blendPos, asset: USDT0_MAINNET_SAC }
    const prices = { ['USDT0:' + USDT0_ISSUER]: 1.0 }
    const summary = buildPortfolio([], [usdt0Pos], prices, NOW, {
      network: 'mainnet',
      contractKeys: { [USDT0_MAINNET_SAC]: 'USDT0:' + USDT0_ISSUER },
    })
    const line = summary.lines[0]
    expect(line.code).toBe('USDT0')
    expect(line.valueUsd).toBeCloseTo(10, 6)
  })

  it('ignores an unverified contractKeys mapping instead of trusting it', () => {
    const usdt0Pos: BlendPosition = { ...blendPos, asset: USDT0_MAINNET_SAC }
    // A lying map: the USDT0 contract renamed to a fake USDC issuer. The
    // position must stay unvalued, not priced off the impostor key.
    const prices = { ['USDC:' + FAKE_ISSUER]: 1.0 }
    const summary = buildPortfolio([], [usdt0Pos], prices, NOW, {
      network: 'mainnet',
      contractKeys: { [USDT0_MAINNET_SAC]: 'USDC:' + FAKE_ISSUER },
    })
    expect(summary.lines[0].status).toBe('unresolved')
    expect(summary.lines[0].valueUsd).toBeNull()
    expect(summary.totalUsd).toBeNull()
    expect(summary.lendingUsd).toBeNull()
  })

  it('reports an unresolvable position as unresolved — visible, never valued', () => {
    const mystery: BlendPosition = { ...blendPos, asset: 'GNOTAREGISTEREDCONTRACT' }
    const summary = buildPortfolio([], [mystery], {}, NOW, { network: 'mainnet' })
    const line = summary.lines[0]
    expect(line.status).toBe('unresolved')
    expect(line.valueUsd).toBeNull()
    expect(line.kind).toBe('lending')
    expect(summary.lendingUsd).toBeNull()
  })

  it('sets lendingUsd to null when the position price is unavailable', () => {
    const summary = buildPortfolio([], [blendPos], {}, NOW, { network: 'mainnet' })
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
