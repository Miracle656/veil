// react-dom/server needs TextEncoder at module load; jsdom omits it.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { createElement } from 'react'
import * as React from 'react'
// jest's inline tsconfig uses the classic JSX runtime, so the component's
// compiled output reads a React global that Next's automatic runtime omits.
Object.assign(globalThis, { React })
import { renderToStaticMarkup } from 'react-dom/server'
import { PortfolioSummary } from '../PortfolioSummary'
import { buildPortfolio } from '@/lib/portfolio'
import type { WalletAsset } from '@/lib/walletTypes'
import type { BlendPosition } from '@/lib/blend'

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const USDY_ISSUER = 'GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6'

const NOW = 1_800_000_000_000

function render(portfolio: ReturnType<typeof buildPortfolio>, hideAmounts = false): string {
  return renderToStaticMarkup(
    createElement(PortfolioSummary, {
      portfolio,
      currencyCode: 'USD',
      fxRate: 1,
      hideAmounts,
    }),
  )
}

describe('PortfolioSummary', () => {
  // ── Empty portfolio ────────────────────────────────────────────────────────

  it('renders an empty state when there are no assets', () => {
    const portfolio = buildPortfolio([], [], {}, NOW)
    const html = render(portfolio)
    expect(html).toMatch(/No assets yet/)
    expect(html).not.toMatch(/Cash/)
  })

  // ── Missing price ──────────────────────────────────────────────────────────

  it('shows an em dash for unpriced assets, not zero', () => {
    const xlm: WalletAsset = { code: 'XLM', issuer: null, balance: '100' }
    const portfolio = buildPortfolio([xlm], [], {}, NOW)
    const html = render(portfolio)
    // Em dash present for the unpriced line
    expect(html).toMatch(/—/)
    // No confident zero shown
    expect(html).not.toMatch(/\$0\.00/)
    expect(html).not.toMatch(/\$0/)
  })

  it('marks an unpriced line without contributing it to the total', () => {
    const xlm:  WalletAsset = { code: 'XLM',  issuer: null,        balance: '100' }
    const usdc: WalletAsset = { code: 'USDC', issuer: USDC_ISSUER, balance: '50'  }
    const prices = { ['USDC:' + USDC_ISSUER]: 1.0 }
    const portfolio = buildPortfolio([xlm, usdc], [], prices, NOW)
    const html = render(portfolio)
    // Total reflects USDC only ($50.00), not XLM
    expect(html).toMatch(/\$50\.00/)
    // XLM line shows an em dash
    expect(html).toMatch(/—/)
  })

  // ── All assets priced: totals displayed ───────────────────────────────────

  it('renders the total value and bucket headers when all assets are priced', () => {
    const usdc: WalletAsset = { code: 'USDC', issuer: USDC_ISSUER, balance: '50' }
    const usdy: WalletAsset = { code: 'USDY', issuer: USDY_ISSUER, balance: '25' }
    const prices = {
      ['USDC:' + USDC_ISSUER]: 1.0,
      ['USDY:' + USDY_ISSUER]: 1.002,
    }
    const portfolio = buildPortfolio([usdc, usdy], [], prices, NOW)
    const html = render(portfolio)
    expect(html).toMatch(/Cash/)
    expect(html).toMatch(/Invest/)
    // Total ≈ $75.05
    expect(html).toMatch(/\$75\.05/)
  })

  it('renders a lending bucket when Blend positions are present', () => {
    const blendPos: BlendPosition = {
      poolId: 'CPOOL', asset: USDC_ISSUER,
      deposited: '100000000', bTokenBalance: '100000000', accruedInterest: '0',
    }
    const prices = { [USDC_ISSUER]: 1.0 }
    const portfolio = buildPortfolio([], [blendPos], prices, NOW)
    const html = render(portfolio)
    expect(html).toMatch(/Lending/)
    expect(html).toMatch(/\$10\.00/)
  })

  // ── Hide amounts ──────────────────────────────────────────────────────────

  it('masks all amounts when hideAmounts is true', () => {
    const usdc: WalletAsset = { code: 'USDC', issuer: USDC_ISSUER, balance: '50' }
    const prices = { ['USDC:' + USDC_ISSUER]: 1.0 }
    const portfolio = buildPortfolio([usdc], [], prices, NOW)
    const html = render(portfolio, true)
    expect(html).toMatch(/••••/)
    expect(html).not.toMatch(/50\.00/)
  })

  // ── Totals reconcile ──────────────────────────────────────────────────────

  it('total value rendered matches the sum of the parts', () => {
    const xlm:  WalletAsset = { code: 'XLM',  issuer: null,        balance: '100' }
    const usdc: WalletAsset = { code: 'USDC', issuer: USDC_ISSUER, balance: '50'  }
    const prices = {
      XLM:                     0.1,
      ['USDC:' + USDC_ISSUER]: 1.0,
    }
    const portfolio = buildPortfolio([xlm, usdc], [], prices, NOW)
    // Expected total: 100 * 0.1 + 50 * 1.0 = $60.00
    expect(portfolio.totalUsd).toBeCloseTo(60, 10)
    const html = render(portfolio)
    expect(html).toMatch(/\$60\.00/)
  })

  // ── Priced-at timestamp ───────────────────────────────────────────────────

  it('shows a "Priced at" label in the footer', () => {
    const usdc: WalletAsset = { code: 'USDC', issuer: USDC_ISSUER, balance: '1' }
    const prices = { ['USDC:' + USDC_ISSUER]: 1.0 }
    const portfolio = buildPortfolio([usdc], [], prices, NOW)
    const html = render(portfolio)
    expect(html).toMatch(/Priced at/)
  })
})
