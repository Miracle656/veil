/**
 * #1201 — the web swap must apply the SAME affordability rule as the mobile
 * app, not a second slightly different one. `lib/sdexSwapFeeAttach.ts` is a
 * byte-for-byte mirror of `frontend/mobile/lib/sdexSwapFeeAttach.ts`, and this
 * suite pins both halves: the behaviour at each edge, and the fact that the
 * two files have not drifted.
 *
 * If the drift test goes red, you edited one copy alone — make the same change
 * in both. Do not "fix" it here. The edges:
 *
 *   1. The inclusion fee at the transaction's real operation count. The fee op
 *      adds an operation, and an account that cannot cover its whole bid above
 *      reserve is rejected with txINSUFFICIENT_BALANCE — the swap dies over a
 *      fee nobody asked for.
 *   2. The 0.5 XLM subentry reserve a changeTrust in the same transaction
 *      locks once it settles; the spendable read cannot see it beforehand.
 */

import * as fs from 'fs'
import * as path from 'path'

import { canAffordSdexSwapFee, type SdexSwapFeeMargin } from '../sdexSwapFeeAttach'

// 100 stroops = 0.00001 XLM per operation (testnet), 100,000 = 0.01 XLM (the
// mainnet surge bid). 10 XLM swapped, 0.1 XLM fee.
const TESTNET_BID = 100

const base: SdexSwapFeeMargin = {
  spendableXlm: '0',
  nativeAmountIn: '10',
  feeAmount: '0.1',
  perOpBidStroops: TESTNET_BID,
  opsWithoutFee: 1,
  addsTrustline: false,
}

const margin = (over: Partial<SdexSwapFeeMargin>): SdexSwapFeeMargin => ({ ...base, ...over })

describe('the inclusion fee, at the real operation count', () => {
  it('refuses the fee when the account covers swap + fee but not the fee op\'s own bid', () => {
    // 10.1 pays amountIn + fee — exactly what the old comparison checked. With
    // the fee op, the transaction bids for 2 ops: 10 + 0.1 + 2 × 0.00001 = 10.10002.
    expect(canAffordSdexSwapFee(margin({ spendableXlm: '10.1000100' }))).toBe(false)
  })

  it('charges the fee at the last stroop the transaction actually needs', () => {
    expect(canAffordSdexSwapFee(margin({ spendableXlm: '10.1000200' }))).toBe(true)
  })

  it('prices the bid for the trustline op too — a 3-op tx needs 3 bids', () => {
    // changeTrust + pathPayment + fee: 10 + 0.1 + 3 × 0.00001 = 10.10003.
    const threeOps = margin({ opsWithoutFee: 2, addsTrustline: false })
    expect(canAffordSdexSwapFee({ ...threeOps, spendableXlm: '10.1000200' })).toBe(false)
    expect(canAffordSdexSwapFee({ ...threeOps, spendableXlm: '10.1000300' })).toBe(true)
  })

  it('holds at the mainnet surge bid, where one extra op costs 0.01 XLM', () => {
    // 10 + 0.1 + 2 × 0.01 = 10.12. Under the old check, 10.1 looked affordable.
    const mainnet = margin({ perOpBidStroops: 100_000 })
    expect(canAffordSdexSwapFee({ ...mainnet, spendableXlm: '10.1199900' })).toBe(false)
    expect(canAffordSdexSwapFee({ ...mainnet, spendableXlm: '10.1200000' })).toBe(true)
  })
})

describe('a trustline added by the same transaction', () => {
  it('refuses the fee when swap + fee + bid fit but the new subentry reserve does not', () => {
    // Without the trustline, 10.10003 is exactly enough; changeTrust then locks
    // a further 0.5 XLM the moment it settles.
    expect(
      canAffordSdexSwapFee(margin({ spendableXlm: '10.1000300', opsWithoutFee: 2, addsTrustline: true })),
    ).toBe(false)
  })

  it('charges the fee once the 0.5 XLM subentry is inside the margin', () => {
    // 10 + 0.1 + 3 × 0.00001 + 0.5 = 10.60003.
    expect(
      canAffordSdexSwapFee(margin({ spendableXlm: '10.6000300', opsWithoutFee: 2, addsTrustline: true })),
    ).toBe(true)
  })

  it('locks no reserve when the account already trusts the destination', () => {
    expect(canAffordSdexSwapFee(margin({ spendableXlm: '10.1000200', addsTrustline: false }))).toBe(true)
  })
})

describe('anything unreadable means no fee, never a failed swap', () => {
  it.each([
    ['a fee with more precision than Stellar has', { feeAmount: '0.123456789' }],
    ['a zero fee', { feeAmount: '0' }],
    ['a negative fee', { feeAmount: '-0.1' }],
    ['a non-numeric fee', { feeAmount: 'free' }],
    ['a zero amount in', { nativeAmountIn: '0' }],
    ['a spendable that is not a number', { spendableXlm: 'nope' }],
    ['a negative bid', { perOpBidStroops: -1 }],
    ['no operations in the transaction', { opsWithoutFee: 0 }],
  ])('refuses the fee for %s', (_label, over) => {
    expect(canAffordSdexSwapFee(margin({ spendableXlm: '1000', ...over }))).toBe(false)
  })
})

describe('mobile and web run one rule, not two (#1201)', () => {
  it('the wallet helper is byte-identical to the mobile one — edit both together', () => {
    // Line endings are per-checkout noise; every byte of the rule itself must match.
    const walletSrc = fs
      .readFileSync(path.join(__dirname, '..', 'sdexSwapFeeAttach.ts'), 'utf8')
      .replace(/\r\n/g, '\n')
    const mobileSrc = fs
      .readFileSync(path.join(__dirname, '..', '..', '..', 'mobile', 'lib', 'sdexSwapFeeAttach.ts'), 'utf8')
      .replace(/\r\n/g, '\n')
    // If this fails, the margin was edited on one client only, and a swap at
    // the last stroop is affordable on one app and fatal on the other.
    expect(walletSrc).toBe(mobileSrc)
  })
})
