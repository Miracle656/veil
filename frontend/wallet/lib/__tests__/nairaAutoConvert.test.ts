// @stellar/stellar-sdk needs TextEncoder at module load; jsdom omits it.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import {
  AUTO_CONVERT_SLIPPAGE_BPS,
  approveAutoConvert,
  markAutoConverted,
  minUsdcOut,
  planAutoConvert,
  shouldAutoConvert,
} from '../nairaAutoConvert'

describe('planAutoConvert', () => {
  it('converts what was delivered, less the 2 XLM kept back', () => {
    // 7.2021798 XLM arrives in a new account: 1 XLM is locked, so 6.2021798 is
    // spendable. The trustline about to be added locks 0.5 more.
    expect(
      planAutoConvert({ deliveredXlm: 7.2021798, spendableXlm: '6.2021798', hasUsdcTrustline: false }),
    ).toBe('5.2000000')
  })

  it('leaves alone XLM that was already in the account', () => {
    // 100 XLM was there before; only this order's delivery is converted.
    expect(
      planAutoConvert({ deliveredXlm: 24.33, spendableXlm: '122.5', hasUsdcTrustline: true }),
    ).toBe('22.3300000')
  })

  it('takes less when the account cannot spend the full amount', () => {
    // Delivery says 20, but only 5 is spendable and a trustline is needed.
    expect(planAutoConvert({ deliveredXlm: 20, spendableXlm: '5', hasUsdcTrustline: false })).toBe('4.4000000')
    // With the trustline already there, the 0.5 is not set aside again.
    expect(planAutoConvert({ deliveredXlm: 20, spendableXlm: '5', hasUsdcTrustline: true })).toBe('4.9000000')
  })

  it('converts nothing when too little arrived or nothing is spendable', () => {
    expect(planAutoConvert({ deliveredXlm: 2, spendableXlm: '50', hasUsdcTrustline: true })).toBeNull()
    expect(planAutoConvert({ deliveredXlm: 1.5, spendableXlm: '50', hasUsdcTrustline: true })).toBeNull()
    expect(planAutoConvert({ deliveredXlm: 20, spendableXlm: '0.55', hasUsdcTrustline: false })).toBeNull()
    expect(planAutoConvert({ deliveredXlm: Number.NaN, spendableXlm: '5', hasUsdcTrustline: true })).toBeNull()
    expect(planAutoConvert({ deliveredXlm: 20, spendableXlm: 'nope', hasUsdcTrustline: true })).toBeNull()
  })

  it('never rounds up past what is there', () => {
    const amount = planAutoConvert({ deliveredXlm: 10.999, spendableXlm: '9.999', hasUsdcTrustline: true })
    expect(amount).toBe('8.9900000')
    expect(Number(amount)).toBeLessThanOrEqual(10.999 - 2)
  })
})

describe('minUsdcOut', () => {
  it('is the quote less one percent, rounded down', () => {
    expect(AUTO_CONVERT_SLIPPAGE_BPS).toBe(100)
    expect(minUsdcOut('2.9580461')).toBe('2.9284656')
    expect(minUsdcOut('100')).toBe('99.0000000')
  })

  it('refuses a quote it cannot trust', () => {
    expect(minUsdcOut('0')).toBeNull()
    expect(minUsdcOut('-1')).toBeNull()
    expect(minUsdcOut('abc')).toBeNull()
  })
})

describe('the approval', () => {
  beforeEach(() => window.localStorage.clear())

  it('covers the approved order only', () => {
    expect(shouldAutoConvert('order-1')).toBe(false)
    approveAutoConvert('order-1')
    expect(shouldAutoConvert('order-1')).toBe(true)
    expect(shouldAutoConvert('order-2')).toBe(false)
  })

  it('is spent once the swap has gone out, so a refresh cannot swap again', () => {
    approveAutoConvert('order-1')
    markAutoConverted('order-1', 'abc123')
    expect(shouldAutoConvert('order-1')).toBe(false)
  })

  it('is replaced by a newer order', () => {
    approveAutoConvert('order-1')
    approveAutoConvert('order-2')
    expect(shouldAutoConvert('order-1')).toBe(false)
    expect(shouldAutoConvert('order-2')).toBe(true)
  })

  it('reads a damaged record as no approval', () => {
    window.localStorage.setItem('veil_ngn_autoconvert', '{not json')
    expect(shouldAutoConvert('order-1')).toBe(false)
  })
})
