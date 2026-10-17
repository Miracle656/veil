import {
  ASSET_REGISTRY,
  ETHERFUSE_MAINNET_ISSUER,
  getAssetIssuer,
  getRegisteredAsset,
  horizonAssetType,
  isRegisteredIssuer,
  verifiedAsset,
} from '../assets'

const LOOKALIKE_ISSUER = 'GFAKE123456789012345678901234567890123456789012345678901'
const BONDS = ['CETES', 'USTRY', 'TESOURO', 'KTB', 'EUROB', 'GILTS'] as const

describe('Etherfuse Stablebonds are pinned by issuer (#1060/#1062)', () => {
  it('registers all six codes against the one genuine issuer', () => {
    for (const code of BONDS) {
      const asset = ASSET_REGISTRY[code]
      expect(asset.issuer).toBe(ETHERFUSE_MAINNET_ISSUER)
      expect(asset.kind).toBe('treasury')
      expect(asset.obligor).toBeTruthy()
    }
  })

  it('accepts the genuine issuer and rejects a lookalike for every code', () => {
    for (const code of BONDS) {
      expect(isRegisteredIssuer(code, ETHERFUSE_MAINNET_ISSUER, 'mainnet')).toBe(true)
      expect(isRegisteredIssuer(code, LOOKALIKE_ISSUER, 'mainnet')).toBe(false)
      expect(getRegisteredAsset(code, LOOKALIKE_ISSUER)).toBeNull()
      expect(verifiedAsset(code, LOOKALIKE_ISSUER, 'mainnet')).toBeNull()
    }
  })

  it('is mainnet-only, so a testnet lookup does not offer the bonds', () => {
    for (const code of BONDS) {
      expect(getAssetIssuer(code, 'testnet')).toBeNull()
      expect(getRegisteredAsset(code, 'testnet')).toBeNull()
    }
  })

  it('derives the Horizon asset type from each code length', () => {
    // CETES (5), USTRY (5) and TESOURO (7) are credit_alphanum12; KTB (3) is
    // credit_alphanum4, which is why the type must be derived, not assumed.
    expect(horizonAssetType('CETES')).toBe('credit_alphanum12')
    expect(horizonAssetType('USTRY')).toBe('credit_alphanum12')
    expect(horizonAssetType('TESOURO')).toBe('credit_alphanum12')
    expect(horizonAssetType('KTB')).toBe('credit_alphanum4')
    expect(horizonAssetType('EUROB')).toBe('credit_alphanum12')
    expect(horizonAssetType('GILTS')).toBe('credit_alphanum12')
    for (const code of BONDS) {
      expect(horizonAssetType(code)).toBe(code.length > 4 ? 'credit_alphanum12' : 'credit_alphanum4')
    }
    expect(horizonAssetType('USDC')).toBe('credit_alphanum4')
    expect(horizonAssetType('XLM')).toBe('credit_alphanum4')
  })
})
