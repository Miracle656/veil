/**
 * What "Max" is allowed to fill in.
 *
 * The screen read "5.37 available" and offered a Max that the network refused.
 * Both came from the same flat `balance - 1.5`, which is only right for an
 * account holding exactly one trustline. These pin the two ways that was wrong:
 * too generous on an account with several trustlines, and needlessly stingy on
 * one with none.
 */

import { maxSendable } from '../sendable'

/** 0.01 XLM per operation, the mainnet bid. */
const MAINNET_FEE = '100000'

const xlm = (balance: string, spendable?: string) => ({
  code: 'XLM', issuer: null, balance, spendable,
})

describe('maxSendable', () => {
  // 5.37 XLM with one trustline: reserve 1.5, so 3.87 is spendable, less the
  // two-operation bid.
  it('offers the spendable balance, not the balance', () => {
    expect(maxSendable(xlm('5.3721000', '3.8721000'), MAINNET_FEE)).toBeCloseTo(3.8521, 4)
  })

  // The bug as it shipped: four trustlines lock 3 XLM, and the old flat 1.5
  // left 1.5 XLM of reserve on the table. Every Max send failed.
  it('does not offer what a multi-trustline account cannot release', () => {
    const offered = maxSendable(xlm('5.3721000', '2.3721000'), MAINNET_FEE)
    expect(offered).toBeLessThan(2.3721)
    expect(offered).toBeCloseTo(2.3521, 4)
  })

  // The same bug in the other direction, on an account with no trustlines at
  // all: 0.5 XLM was withheld for a reserve that does not exist.
  it('releases what a bare account really can send', () => {
    expect(maxSendable(xlm('5.3721000', '4.3721000'), MAINNET_FEE)).toBeCloseTo(4.3521, 4)
  })

  // The inclusion fee has to clear the reserve too. A Max that spends to the
  // last stroop is rejected by exactly the width of the bid.
  it('leaves room for the fee, for both operations', () => {
    const offered = maxSendable(xlm('10', '10'), MAINNET_FEE)
    expect(10 - offered).toBeCloseTo(0.02, 7)
  })

  it('never returns a negative amount', () => {
    expect(maxSendable(xlm('0.9', '0'), MAINNET_FEE)).toBe(0)
    expect(maxSendable(xlm('0.0000001', '0.0000001'), MAINNET_FEE)).toBe(0)
  })

  // Issued assets carry no reserve and pay no fee in their own units.
  it('offers an issued balance in full', () => {
    const usdc = { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', balance: '12.5' }
    expect(maxSendable(usdc, MAINNET_FEE)).toBe(12.5)
  })

  // An asset named XLM with an issuer is somebody's token, not the native one.
  it('treats an issued XLM lookalike as an ordinary token', () => {
    const fake = { code: 'XLM', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', balance: '3' }
    expect(maxSendable(fake, MAINNET_FEE)).toBe(3)
  })

  it('falls back to the balance when no spendable figure was computed', () => {
    expect(maxSendable({ code: 'USDC', issuer: 'GABC', balance: '7' }, MAINNET_FEE)).toBe(7)
    expect(maxSendable({ code: 'XLM', issuer: null, balance: '0' }, MAINNET_FEE)).toBe(0)
  })

  it('is zero for a balance that is not a number', () => {
    expect(maxSendable(xlm('', undefined), MAINNET_FEE)).toBe(0)
  })
})
