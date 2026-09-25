/**
 * Verified asset registry (V176) mapping short token keys to exact issuer addresses
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
  reserveXlm?: number
  sacContractId?: string
}

export const USDY_MAINNET_ISSUER = 'GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6'
export const USDT0_MAINNET_ISSUER = 'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q'
export const USDT0_MAINNET_SAC = 'CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF'

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
    name: 'Tether USD',
    issuerName: 'Tether',
    network: 'mainnet',
    kind: 'stablecoin',
    reserveXlm: 0.5,
    sacContractId: USDT0_MAINNET_SAC,
  },
}

export function getRegisteredAsset(code: string, network?: 'mainnet' | 'testnet'): RegisteredAsset | null {
  const asset = ASSET_REGISTRY[code.toUpperCase()] ?? null
  if (!asset) return null
  if (network && asset.network !== 'all' && asset.network !== network) {
    return null
  }
  return asset
}

export function getAssetIssuer(code: string, network: 'mainnet' | 'testnet' = 'mainnet'): string | null {
  // USDC first: it is registered `network: 'mainnet'`, so a registry lookup
  // for testnet returns null and every branch below becomes unreachable.
  if (code.toUpperCase() === 'USDC' && network === 'testnet') {
    return 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
  }
  const asset = getRegisteredAsset(code, network)
  if (!asset) return null
  if (asset.network === 'mainnet' && network === 'testnet') {
    return null
  }
  return asset.issuer
}

export function isRegisteredIssuer(code: string, issuer: string, network: 'mainnet' | 'testnet' = 'mainnet'): boolean {
  // USDC first: it is registered `network: 'mainnet'`, so a registry lookup
  // for testnet returns null and every branch below becomes unreachable.
  if (code.toUpperCase() === 'USDC') {
    return (
      issuer === 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' ||
      issuer === 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
    )
  }
  const asset = getRegisteredAsset(code, network)
  if (!asset) return false
  if (asset.network === 'mainnet' && network === 'testnet') {
    return false
  }
  return asset.issuer === issuer
}

export interface HorizonIssuerFlags {
  auth_required?: boolean
  auth_revocable?: boolean
  auth_clawback_enabled?: boolean
  auth_immutable?: boolean
}

export function getAssetControlDisclosure(flags?: HorizonIssuerFlags | null): string | null {
  if (!flags) return null
  if (flags.auth_revocable && flags.auth_clawback_enabled) {
    return 'The issuer can freeze this balance or take it back, and this is a property of the asset, not of Veil.'
  }
  if (flags.auth_clawback_enabled) {
    return 'The issuer can take this balance back, and this is a property of the asset, not of Veil.'
  }
  if (flags.auth_revocable) {
    return 'The issuer can freeze this balance, and this is a property of the asset, not of Veil.'
  }
  return null
}

export async function fetchIssuerFlags(
  server: { loadAccount: (id: string) => Promise<any> },
  issuer: string,
): Promise<HorizonIssuerFlags | null> {
  try {
    const account = await server.loadAccount(issuer)
    return (account?.flags as HorizonIssuerFlags) ?? null
  } catch {
    return null
  }
}

export async function fetchAssetDisclosure(
  server: { loadAccount: (id: string) => Promise<any> },
  issuer: string,
): Promise<string | null> {
  const flags = await fetchIssuerFlags(server, issuer)
  return getAssetControlDisclosure(flags)
}

