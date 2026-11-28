/**
 * @jest-environment node
 */
import { Asset, Networks } from '@stellar/stellar-sdk'

import { USDC_MAINNET_ISSUER } from '../assets'
import {
  formatApy,
  reserveFor,
  reserveLabel,
  verifiedCodeForContract,
  yearlyEarnings,
  type BlendReserve,
} from '../blendReserves'

// The pool Veil supplies to, as read from mainnet on 2026-11-28.
const XLM_ID = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA'
const USDC_ID = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
const EURC_ID = 'CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV'
const RESERVES: BlendReserve[] = [
  { asset: XLM_ID, code: 'XLM', supplyApy: 0, totalSupplied: 698769898.79 },
  { asset: USDC_ID, code: 'USDC', supplyApy: 0.0647, totalSupplied: 39548560.11 },
]

describe('verifiedCodeForContract', () => {
  it('names the three assets the mainnet pool lends: XLM, USDC and EURC', () => {
    expect(verifiedCodeForContract(XLM_ID, 'mainnet', Networks.PUBLIC)).toBe('XLM')
    expect(verifiedCodeForContract(USDC_ID, 'mainnet', Networks.PUBLIC)).toBe('USDC')
    expect(verifiedCodeForContract(EURC_ID, 'mainnet', Networks.PUBLIC)).toBe('EURC')
  })

  it('does not name a token that only calls itself USDC', () => {
    const impostorIssuer = 'GADUBOKGYG4E2BZUVXAZBBILGPIYIPOXAXWIIG6DJ4JDXWOQR67HUSDT'
    const impostor = new Asset('USDC', impostorIssuer).contractId(Networks.PUBLIC)
    expect(verifiedCodeForContract(impostor, 'mainnet', Networks.PUBLIC)).toBeNull()
  })

  it('does not carry a mainnet asset over to testnet', () => {
    const mainnetUsdcOnTestnet = new Asset('USDC', USDC_MAINNET_ISSUER).contractId(Networks.TESTNET)
    expect(verifiedCodeForContract(mainnetUsdcOnTestnet, 'testnet', Networks.TESTNET)).toBeNull()
    expect(verifiedCodeForContract(USDC_ID, 'testnet', Networks.TESTNET)).toBeNull()
  })

  it('returns null for something that is not a contract id', () => {
    expect(verifiedCodeForContract('', 'mainnet', Networks.PUBLIC)).toBeNull()
  })
})

describe('reserveFor', () => {
  it('finds the row for the asset being deposited', () => {
    expect(reserveFor(RESERVES, USDC_ID)?.supplyApy).toBe(0.0647)
    expect(reserveFor(RESERVES, XLM_ID)?.supplyApy).toBe(0)
  })

  it('returns null when the pool does not lend the asset, or none is chosen', () => {
    expect(reserveFor(RESERVES, EURC_ID)).toBeNull()
    expect(reserveFor(RESERVES, null)).toBeNull()
    expect(reserveFor(RESERVES, '')).toBeNull()
  })
})

describe('what the screen shows', () => {
  it('shows each asset its own rate, never an average', () => {
    // The old screen showed (0 + 6.47) / 2 for both.
    expect(formatApy(reserveFor(RESERVES, XLM_ID)?.supplyApy)).toBe('0.00%')
    expect(formatApy(reserveFor(RESERVES, USDC_ID)?.supplyApy)).toBe('6.47%')
  })

  it('shows a dash, not 0, when there is no rate', () => {
    expect(formatApy(undefined)).toBe('—')
    expect(formatApy(null)).toBe('—')
    expect(formatApy(NaN)).toBe('—')
    expect(formatApy(Infinity)).toBe('—')
  })

  it('labels a verified asset by code and an unverified one by its whole contract id', () => {
    expect(reserveLabel(RESERVES[1])).toBe('USDC')
    expect(reserveLabel({ asset: XLM_ID, code: null })).toBe(XLM_ID)
  })

  it('estimates a year of earnings from the asset rate', () => {
    expect(yearlyEarnings('100', 0.0647)).toBe('6.4700')
    expect(yearlyEarnings('100', 0)).toBe('0.0000')
  })

  it('shows no estimate without an amount or a rate', () => {
    expect(yearlyEarnings('', 0.05)).toBeNull()
    expect(yearlyEarnings('0', 0.05)).toBeNull()
    expect(yearlyEarnings('-5', 0.05)).toBeNull()
    expect(yearlyEarnings('abc', 0.05)).toBeNull()
    expect(yearlyEarnings('100', undefined)).toBeNull()
    expect(yearlyEarnings('100', NaN)).toBeNull()
  })
})
