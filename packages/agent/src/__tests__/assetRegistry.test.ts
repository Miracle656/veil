import { describe, it, expect } from '@jest/globals'
import { StrKey } from '@stellar/stellar-sdk'

import {
  ASSET_REGISTRY,
  USDC_MAINNET_ISSUER,
  USDT0_MAINNET_ISSUER,
  classifyHolding,
  getRegisteredAsset,
  isRegisteredIssuer,
} from '../assetRegistry.js'

/** A well-formed G… that no registry entry uses: an impostor issuer. */
const FAKE_ISSUER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0x21))

describe('asset registry (#821)', () => {
  it('pins only well-formed issuers', () => {
    for (const entries of Object.values(ASSET_REGISTRY)) {
      for (const asset of Object.values(entries)) {
        expect(StrKey.isValidEd25519PublicKey(asset.issuer)).toBe(true)
      }
    }
  })

  it('matches on issuer, not on code', () => {
    expect(isRegisteredIssuer('USDT0', USDT0_MAINNET_ISSUER, 'mainnet')).toBe(true)
    expect(isRegisteredIssuer('USDT0', FAKE_ISSUER, 'mainnet')).toBe(false)
    expect(isRegisteredIssuer('USDC', USDT0_MAINNET_ISSUER, 'mainnet')).toBe(false)
  })

  it('has no testnet USDT0, so no testnet issuer can be verified as it', () => {
    expect(getRegisteredAsset('USDT0', 'testnet')).toBeNull()
    expect(isRegisteredIssuer('USDT0', USDT0_MAINNET_ISSUER, 'testnet')).toBe(false)
  })
})

describe('classifyHolding', () => {
  it('names the issuer when reporting a registered asset', () => {
    const h = classifyHolding('USDC', USDC_MAINNET_ISSUER, '12.5', 'mainnet')
    expect(h).toMatchObject({ verified: true, issuer: USDC_MAINNET_ISSUER, issuerName: 'Circle', name: 'USD Coin' })
    expect(h.note).toContain(USDC_MAINNET_ISSUER)
  })

  it('reports a counterfeit of a registered code as unverified, with both issuers', () => {
    const h = classifyHolding('USDC', FAKE_ISSUER, '1000', 'mainnet')
    expect(h.verified).toBe(false)
    expect(h.name).toBeUndefined()
    expect(h.note).toMatch(/^UNVERIFIED/)
    expect(h.note).toContain(FAKE_ISSUER)
    expect(h.note).toContain(USDC_MAINNET_ISSUER)
  })

  it('reports an unlisted asset as unverified, with its issuer', () => {
    const h = classifyHolding('AQUA', FAKE_ISSUER, '3', 'mainnet')
    expect(h.verified).toBe(false)
    expect(h.note).toMatch(/^UNVERIFIED/)
    expect(h.note).toContain(FAKE_ISSUER)
  })
})
