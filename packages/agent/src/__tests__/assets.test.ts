import { describe, it, expect } from '@jest/globals'
import { Networks, StrKey } from '@stellar/stellar-sdk'
import {
  USDT0_MAINNET_ISSUER,
  USDT0_MAINNET_SAC,
  classifyBalances,
  classifyHolding,
  deriveSac,
  describeAsset,
  registeredAsset,
} from '../assets.js'

// Impostor issuers of an asset also called USDT0 (mainnet Horizon, 2026-09-24).
const FAKE_A = 'GC35JBERU4SFTDVOF32A2SIJN5FHSLSZFZSGP6VVFWCZNDVGJFLQBANK'
const FAKE_B = 'GADUBOKGYG4E2BZUVXAZBBILGPIYIPOXAXWIIG6DJ4JDXWOQR67HUSDT'

describe('pinned USDT0 constants', () => {
  it('are checksum-valid, not just the right shape', () => {
    expect(StrKey.isValidEd25519PublicKey(USDT0_MAINNET_ISSUER)).toBe(true)
    expect(StrKey.isValidContract(USDT0_MAINNET_SAC)).toBe(true)
    expect(StrKey.isValidEd25519PublicKey(FAKE_A)).toBe(true)
    expect(StrKey.isValidEd25519PublicKey(FAKE_B)).toBe(true)
  })

  it('derive the pinned SAC from the issuer', () => {
    const usdt0 = registeredAsset('USDT0', 'mainnet')!
    expect(deriveSac(usdt0, Networks.PUBLIC)).toBe(USDT0_MAINNET_SAC)
    expect(usdt0.sac).toBe(USDT0_MAINNET_SAC)
  })
})

describe('classifyHolding', () => {
  it('a real USDT0 is verified and names its issuer', () => {
    const h = classifyHolding('USDT0', USDT0_MAINNET_ISSUER, '12.5000000', 'mainnet')
    expect(h.status).toBe('verified')
    expect(h.message).toContain(USDT0_MAINNET_ISSUER)
  })

  it('a fake USDT0 with the same code is unverified, with its issuer shown', () => {
    const h = classifyHolding('USDT0', FAKE_A, '999.0000000', 'mainnet')
    expect(h.status).toBe('unverified')
    expect(h.issuer).toBe(FAKE_A)
    expect(h.registeredIssuer).toBe(USDT0_MAINNET_ISSUER)
    expect(h.message).toMatch(/UNVERIFIED/)
    expect(h.message).toContain(FAKE_A)
  })

  it('never matches on code alone: case games do not verify either', () => {
    expect(classifyHolding('usdt0', FAKE_B, '1', 'mainnet').status).toBe('unverified')
  })

  it('has no verified USDT0 on testnet', () => {
    expect(classifyHolding('USDT0', USDT0_MAINNET_ISSUER, '1', 'testnet').status).toBe('unlisted')
  })

  it('claims nothing about a code that is not in the registry', () => {
    expect(classifyHolding('SCAM', FAKE_A, '1', 'mainnet').status).toBe('unlisted')
  })
})

describe('classifyBalances', () => {
  it('classifies issued assets from a getBalances result and skips XLM', () => {
    const holdings = classifyBalances(
      {
        XLM: '10.0000000',
        XLM_feepayer: '5.0000000',
        XLM_contract: '5.0000000',
        [`USDT0:${USDT0_MAINNET_ISSUER}`]: '3.0000000',
        [`USDT0:${FAKE_A}`]: '7.0000000',
      },
      'mainnet',
    )
    expect(holdings.map((h) => [h.issuer, h.status])).toEqual([
      [USDT0_MAINNET_ISSUER, 'verified'],
      [FAKE_A, 'unverified'],
    ])
  })
})

describe('describeAsset', () => {
  it('states the issuer and the clawback and freeze property', () => {
    const a = describeAsset('USDT0', 'mainnet')
    expect(a.issuer).toBe(USDT0_MAINNET_ISSUER)
    expect(a.sac).toBe(USDT0_MAINNET_SAC)
    expect(a.issuerControls).toEqual({ clawback: true, freeze: true })
    expect(a.message).toMatch(/claw back/)
    expect(a.message).toMatch(/freeze/)
  })

  it('checks a specific issuer', () => {
    expect(describeAsset(`USDT0:${USDT0_MAINNET_ISSUER}`, 'mainnet').status).toBe('verified')
    const fake = describeAsset(`USDT0:${FAKE_A}`, 'mainnet')
    expect(fake.status).toBe('unverified')
    expect(fake.message).toMatch(/UNVERIFIED/)
  })

  it('says so for an unregistered asset', () => {
    expect(describeAsset('SCAM', 'mainnet').status).toBe('unknown')
  })
})
