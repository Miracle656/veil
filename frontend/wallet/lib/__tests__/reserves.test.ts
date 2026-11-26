// @stellar/stellar-sdk needs TextEncoder at module load; jsdom omits it.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import {
  calculateAccountReserve,
  spendableNativeXlm,
  TRUSTLINE_RESERVE_COST_XLM,
  TRUSTLINE_RESERVE_EXPLANATION,
} from '../reserves'

describe('Wallet Reserve Calculations & Explanations (Issue #824)', () => {
  it('derives reserve dynamically for an account with zero trustlines', () => {
    const account = {
      subentry_count: 0,
      balances: [{ asset_type: 'native', balance: '25.0000000' }],
    }

    const res = calculateAccountReserve(account)
    expect(res.subentries).toBe(0)
    expect(res.totalReserve).toBe(1.0)
    expect(res.spendable).toBe('24.0000000')
    expect(res.reason).toContain('1.0 XLM locked for account base reserve')
  })

  it('derives reserve dynamically for an account with one trustline', () => {
    const account = {
      subentry_count: 1,
      balances: [
        { asset_type: 'native', balance: '25.0000000' },
        { asset_type: 'credit_alphanum4', asset_code: 'USDC', balance: '100.0000000' },
      ],
    }

    const res = calculateAccountReserve(account)
    expect(res.subentries).toBe(1)
    expect(res.totalReserve).toBe(1.5)
    expect(res.subentryReserve).toBe(0.5)
    expect(res.spendable).toBe('23.5000000')
    expect(res.reason).toContain('1.5 XLM locked: 1.0 XLM account base reserve + 0.5 XLM for 1 trustline/subentry')
    expect(res.reason).toContain('locked, not spent — released if removed')
  })

  it('derives reserve dynamically for an account with several trustlines', () => {
    const account = {
      subentry_count: 4, // 4 trustlines (e.g. USDC, USDT0, USDY, EURC)
      balances: [
        { asset_type: 'native', balance: '50.0000000' },
      ],
    }

    const res = calculateAccountReserve(account)
    expect(res.subentries).toBe(4)
    expect(res.totalReserve).toBe(3.0) // 1.0 base + 4 * 0.5 = 3.0
    expect(res.subentryReserve).toBe(2.0)
    expect(res.spendable).toBe('47.0000000')
    expect(res.reason).toContain('3.0 XLM locked: 1.0 XLM account base reserve + 2.0 XLM for 4 trustlines/subentries')
    expect(res.reason).toContain('locked, not spent — released if removed')
  })

  it('provides constant 0.5 XLM cost and standard disclosure explanation', () => {
    expect(TRUSTLINE_RESERVE_COST_XLM).toBe(0.5)
    expect(TRUSTLINE_RESERVE_EXPLANATION).toMatch(/0\.5 XLM/)
    expect(TRUSTLINE_RESERVE_EXPLANATION).toMatch(/locked, not spent/)
    expect(TRUSTLINE_RESERVE_EXPLANATION).toMatch(/released/i)
  })
})
