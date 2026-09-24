/**
 * Verified asset registry (V176, V180) mapping short token keys to exact issuer addresses
 * and metadata.
 */

export interface RegisteredAsset {
  code: string
  issuer: string
  name: string
  issuerName: string
  homeDomain?: string
  network: 'mainnet' | 'testnet' | 'all'
  kind: 'treasury' | 'fund' | 'equity' | 'stablecoin' | 'native'
  contractId?: string
  reserveXlm?: number
}

export const USDY_MAINNET_ISSUER = 'GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6'

/**
 * Genuine USDT0 issuer on mainnet (22,348 holders, auth_clawback_enabled: true, no stellar.toml).
 * Pinned specifically to prevent look-alike/impostor tokens with other issuer addresses.
 */
export const USDT0_MAINNET_ISSUER = 'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q'

/**
 * Soroban Classic Asset Contract (SAC) ID for USDT0 on Public Network.
 * Derived from `new Asset('USDT0', USDT0_MAINNET_ISSUER).contractId(Networks.PUBLIC)`.
 */
export const USDT0_MAINNET_SAC_CONTRACT_ID =
  'CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF'

export const ASSET_REGISTRY: Record<string, RegisteredAsset> = {
  USDY: {
    code: 'USDY',
    issuer: USDY_MAINNET_ISSUER,
    name: 'Ondo US Dollar Yield',
    issuerName: 'Ondo Finance',
    homeDomain: 'ondo.finance',
    // Mainnet only: this issuer account does not exist on testnet, so a
    // changeTrust there fails with op_no_issuer.
    network: 'mainnet',
    kind: 'treasury',
    reserveXlm: 0.5,
  },
  USDC: {
    code: 'USDC',
    issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    name: 'USD Coin',
    issuerName: 'Circle',
    homeDomain: 'circle.com',
    network: 'mainnet',
    kind: 'stablecoin',
    reserveXlm: 0.5,
  },
  USDT0: {
    code: 'USDT0',
    issuer: USDT0_MAINNET_ISSUER,
    contractId: USDT0_MAINNET_SAC_CONTRACT_ID,
    name: 'Tether USD',
    issuerName: 'Tether',
    // Mainnet only: USDT0 does not exist on testnet.
    network: 'mainnet',
    kind: 'stablecoin',
    // Note: USDT0 has no home_domain on its issuer account — leave field absent.
    reserveXlm: 0.5,
  },
}

export function getRegisteredAsset(
  code: string,
  network: 'mainnet' | 'testnet' = 'mainnet'
): RegisteredAsset | null {
  const asset = ASSET_REGISTRY[code.toUpperCase()] ?? null
  if (!asset) return null
  if (asset.network !== 'all' && asset.network !== network) {
    return null
  }
  return asset
}

export function getAssetIssuer(
  code: string,
  network: 'mainnet' | 'testnet' = 'mainnet'
): string | null {
  const asset = getRegisteredAsset(code, network)
  if (!asset) return null
  if (code.toUpperCase() === 'USDC' && network === 'testnet') {
    return 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
  }
  return asset.issuer
}

export function isRegisteredIssuer(
  code: string,
  issuer: string,
  network: 'mainnet' | 'testnet' = 'mainnet'
): boolean {
  const asset = getRegisteredAsset(code, network)
  if (!asset) return false
  if (code.toUpperCase() === 'USDC') {
    if (network === 'testnet') {
      return issuer === 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
    }
    return (
      issuer === 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' ||
      issuer === 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
    )
  }
  return asset.issuer === issuer
}
