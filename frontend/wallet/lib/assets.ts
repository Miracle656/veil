/**
 * Verified asset registry mapping short token keys to exact issuer addresses
 * and metadata (Issue #729).
 */

export interface RegisteredAsset {
  code: string
  issuer: string
  name: string
  issuerName: string
  homeDomain: string
  network: 'mainnet' | 'testnet' | 'all'
  kind: 'treasury' | 'fund' | 'equity' | 'stablecoin' | 'native'
  reserveXlm?: number
}

export const USDY_MAINNET_ISSUER = 'GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6'
export const USDC_MAINNET_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
export const USDC_TESTNET_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
export const EURC_MAINNET_ISSUER = 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2'
export const AQUA_MAINNET_ISSUER = 'GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA'

export const ASSET_REGISTRY: Record<string, RegisteredAsset> = {
  USDC: {
    code: 'USDC',
    issuer: USDC_MAINNET_ISSUER,
    name: 'USD Coin',
    issuerName: 'Circle',
    homeDomain: 'circle.com',
    network: 'mainnet',
    kind: 'stablecoin',
    reserveXlm: 0.5,
  },
  XLM: {
    code: 'XLM',
    issuer: '',
    name: 'Stellar Lumens',
    issuerName: 'Stellar Development Foundation',
    homeDomain: 'stellar.org',
    network: 'mainnet',
    kind: 'native',
  },
  EURC: {
    code: 'EURC',
    issuer: EURC_MAINNET_ISSUER,
    name: 'EUR Coin',
    issuerName: 'Circle',
    homeDomain: 'circle.com',
    network: 'mainnet',
    kind: 'stablecoin',
    reserveXlm: 0.5,
  },
  AQUA: {
    code: 'AQUA',
    issuer: AQUA_MAINNET_ISSUER,
    name: 'Aquarius',
    issuerName: 'Aquarius',
    homeDomain: 'aqua.network',
    network: 'mainnet',
    kind: 'equity',
    reserveXlm: 0.5,
  },
  USDY: {
    code: 'USDY',
    issuer: USDY_MAINNET_ISSUER,
    name: 'Ondo US Dollar Yield',
    issuerName: 'Ondo Finance',
    homeDomain: 'ondo.finance',
    network: 'mainnet',
    kind: 'treasury',
    reserveXlm: 0.5,
  },
}

export function getRegisteredAsset(code: string, issuer?: string | null): RegisteredAsset | null {
  const upperCode = code.toUpperCase()
  const asset = ASSET_REGISTRY[upperCode]
  if (!asset) return null

  if (issuer === undefined) return asset

  if (upperCode === 'XLM' || asset.kind === 'native') {
    if (!issuer || issuer === '' || issuer === 'native') return asset
    return null
  }

  if (upperCode === 'USDC' && issuer === USDC_TESTNET_ISSUER) {
    return asset
  }

  return asset.issuer === issuer ? asset : null
}

export function getAssetIssuer(code: string, network: 'mainnet' | 'testnet' = 'mainnet'): string | null {
  const asset = getRegisteredAsset(code)
  if (!asset) return null
  if (code.toUpperCase() === 'USDC' && network === 'testnet') {
    return USDC_TESTNET_ISSUER
  }
  return asset.issuer
}

export function isRegisteredIssuer(code: string, issuer: string): boolean {
  return getRegisteredAsset(code, issuer) !== null
}

export function formatAssetLabel(code: string, issuer?: string | null): string {
  const asset = getRegisteredAsset(code, issuer)
  if (asset) return asset.code

  const shortIssuer = issuer ? `${issuer.slice(0, 4)}…` : 'unknown'
  return `Unverified: ${code.toUpperCase()} (issuer ${shortIssuer})`
}
