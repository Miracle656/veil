// react-dom/server needs TextEncoder at module load; jsdom omits it.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { createElement } from 'react'
import * as React from 'react'
// jest's inline tsconfig uses the classic JSX runtime, so the component's
// compiled output reads a React global that Next's automatic runtime omits.
Object.assign(globalThis, { React })

const WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
// Keyed by issuer, not code: that is the format already on disk from before
// USDY was listed, and changing it would orphan every recorded USTRY cost.
const BASIS_KEY = `veil:recorded-cost-basis:v1:${WALLET}:GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6`
// A USTRY basis recorded before USDY was listed, under the key that shipped.
const USTRY_BASIS_KEY = `veil:recorded-cost-basis:v1:${WALLET}:GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC`
const storedBasis = JSON.stringify({ amount: '100', costUsdc: '100', recordedAt: 1 })

let basisInStorage: string | null = storedBasis
let ustryBasisInStorage: string | null = null

jest.mock('@/lib/walletStorage', () => ({
  walletLocal: {
    getItem: (key: string) =>
      key === BASIS_KEY ? basisInStorage : key === USTRY_BASIS_KEY ? ustryBasisInStorage : null,
    setItem: () => {},
  },
}))

import { renderToStaticMarkup } from 'react-dom/server'
import { PortfolioSummary } from '../PortfolioSummary'
import { buildPortfolio } from '@/lib/portfolio'
import type { WalletAsset } from '@/lib/walletTypes'

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const USDY_ISSUER = 'GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6'
const FAKE_ISSUER = 'GCOUNTERFEITISSUERADDRESS0000000000000000000000000000000000000'
const NOW = 1_800_000_000_000

function render(portfolio: ReturnType<typeof buildPortfolio>, walletAddress: string | null = WALLET): string {
  return renderToStaticMarkup(
    createElement(PortfolioSummary, {
      portfolio,
      currencyCode: 'USD',
      fxRate: 1,
      hideAmounts: false,
      walletAddress,
    }),
  )
}

function usdyLine(balance: string): WalletAsset {
  return { code: 'USDY', issuer: USDY_ISSUER, balance }
}

describe('PortfolioSummary recorded cost basis', () => {
  beforeEach(() => {
    basisInStorage = storedBasis
    ustryBasisInStorage = null
  })

  // Adding USDY must not orphan a basis someone already recorded. The key is
  // built from the issuer; keying it by code instead reads an empty slot and
  // shows "unknown" to every existing USTRY holder, with their stored value
  // still on disk and unreachable.
  it('still reads a USTRY basis stored under the pre-USDY key', () => {
    ustryBasisInStorage = JSON.stringify({ amount: '100', costUsdc: '90', recordedAt: 1 })
    const ustry: WalletAsset = {
      code: 'USTRY',
      issuer: 'GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC',
      balance: '100',
    }
    const portfolio = buildPortfolio([ustry], [], { ['USTRY:' + ustry.issuer]: 1 }, NOW, { network: 'mainnet' })
    const html = render(portfolio)
    // 100 USTRY now worth $100 against a recorded $90 cost → a gain is shown,
    // which is only possible if the stored basis was found.
    expect(html).toContain('10.00')
  })

  it('offers a cost recorder on a USDY line with no basis yet', () => {
    basisInStorage = null
    const portfolio = buildPortfolio([usdyLine('100')], [], { ['USDY:' + USDY_ISSUER]: 1.05 }, NOW, { network: 'mainnet' })
    const html = render(portfolio)
    expect(html).toMatch(/Record cost/)
    expect(html).toMatch(/Change in value unknown/)
  })

  it('shows the recorded basis as a change in value on USDY', () => {
    // 100 USDY at 1.076 USDC vs a recorded 100 USDC cost → +$7.60.
    const portfolio = buildPortfolio([usdyLine('100')], [], { ['USDY:' + USDY_ISSUER]: 1.076 }, NOW, { network: 'mainnet' })
    const html = render(portfolio)
    expect(html).toMatch(/Cost: \$100\.00 USDC/)
    expect(html).toMatch(/Change in value: \+\$7\.60 USDC/)
    expect(html).toMatch(/Edit recorded cost/)
  })

  it('refuses to apply the recorded basis after the holding changes', () => {
    const portfolio = buildPortfolio([usdyLine('150')], [], { ['USDY:' + USDY_ISSUER]: 1.076 }, NOW, { network: 'mainnet' })
    const html = render(portfolio)
    expect(html).toMatch(/Change in value unknown/)
    expect(html).not.toMatch(/Change in value: \+/)
  })

  it('does not offer a basis on USDC', () => {
    const usdc: WalletAsset = { code: 'USDC', issuer: USDC_ISSUER, balance: '50' }
    const portfolio = buildPortfolio([usdc], [], { ['USDC:' + USDC_ISSUER]: 1.0 }, NOW, { network: 'mainnet' })
    const html = render(portfolio)
    expect(html).not.toMatch(/Record cost/)
  })

  it('does not offer a basis on a counterfeit USDY-coded token', () => {
    const fake: WalletAsset = { code: 'USDY', issuer: FAKE_ISSUER, balance: '10' }
    const portfolio = buildPortfolio([fake], [], {}, NOW, { network: 'mainnet' })
    const html = render(portfolio)
    expect(html).not.toMatch(/Record cost/)
  })

  it('hides the basis UI entirely without a wallet address', () => {
    const portfolio = buildPortfolio([usdyLine('100')], [], { ['USDY:' + USDY_ISSUER]: 1.076 }, NOW, { network: 'mainnet' })
    const html = render(portfolio, null)
    expect(html).not.toMatch(/Record cost/)
    expect(html).not.toMatch(/Change in value/)
  })

  it('keeps amounts masked when hideAmounts is on', () => {
    const portfolio = buildPortfolio([usdyLine('100')], [], { ['USDY:' + USDY_ISSUER]: 1.076 }, NOW, { network: 'mainnet' })
    const html = renderToStaticMarkup(
      createElement(PortfolioSummary, {
        portfolio,
        currencyCode: 'USD',
        fxRate: 1,
        hideAmounts: true,
        walletAddress: WALLET,
      }),
    )
    expect(html).not.toMatch(/Change in value/)
    expect(html).toMatch(/••••/)
  })
})
