import {
  ASSET_REGISTRY,
  formatAssetLabel,
  getAssetIssuer,
  getRegisteredAsset,
  isRegisteredIssuer,
} from '../assets'

describe('Verified Asset Registry', () => {
  const LOOKALIKE_ISSUER = 'GFAKE123456789012345678901234567890123456789012345678901'

  it('includes exact registry entries for USDC, XLM, EURC, AQUA, and USDY', () => {
    expect(ASSET_REGISTRY.USDC).toBeDefined()
    expect(ASSET_REGISTRY.XLM).toBeDefined()
    expect(ASSET_REGISTRY.EURC).toBeDefined()
    expect(ASSET_REGISTRY.AQUA).toBeDefined()
    expect(ASSET_REGISTRY.USDY).toBeDefined()
  })

  it('resolves XLM correctly without an issuer field', () => {
    const xlmAsset = getRegisteredAsset('XLM')
    expect(xlmAsset).not.toBeNull()
    expect(xlmAsset?.code).toBe('XLM')
    expect(xlmAsset?.issuer).toBe('')

    expect(getRegisteredAsset('XLM', '')).toEqual(xlmAsset)
    expect(getRegisteredAsset('XLM', null)).toEqual(xlmAsset)
    expect(formatAssetLabel('XLM')).toBe('XLM')
    expect(formatAssetLabel('XLM', '')).toBe('XLM')
  })

  it('labels lookalike issuers (different G... address, same code) as unverified', () => {
    const usdyLookalike = getRegisteredAsset('USDY', LOOKALIKE_ISSUER)
    expect(usdyLookalike).toBeNull()

    const formattedLabel = formatAssetLabel('USDY', LOOKALIKE_ISSUER)
    expect(formattedLabel).toBe('Unverified: USDY (issuer GFAK…)')

    const isRegistered = isRegisteredIssuer('USDY', LOOKALIKE_ISSUER)
    expect(isRegistered).toBe(false)
  })

  it('labels lookalike EURC issuers as unverified', () => {
    const eurcLookalike = getRegisteredAsset('EURC', LOOKALIKE_ISSUER)
    expect(eurcLookalike).toBeNull()
    expect(formatAssetLabel('EURC', LOOKALIKE_ISSUER)).toBe('Unverified: EURC (issuer GFAK…)')
  })

  it('resolves legitimate assets when exact code and issuer match', () => {
    const usdyIssuer = ASSET_REGISTRY.USDY.issuer
    expect(getRegisteredAsset('USDY', usdyIssuer)).not.toBeNull()
    expect(formatAssetLabel('USDY', usdyIssuer)).toBe('USDY')
    expect(isRegisteredIssuer('USDY', usdyIssuer)).toBe(true)
  })

  it('returns appropriate issuer per network', () => {
    expect(getAssetIssuer('USDC', 'mainnet')).toBe(ASSET_REGISTRY.USDC.issuer)
    expect(getAssetIssuer('USDC', 'testnet')).toBe('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5')
  })
})
