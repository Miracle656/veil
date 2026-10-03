/**
 * Verified asset registry (V176) mapping short token keys to exact issuer addresses
 * and metadata.
 *
 * A code alone is not an asset: mainnet has eight assets called USDT0 and seven
 * are impostors. Anything that names, badges, prices or classifies an asset
 * must go through `verifiedAsset`, which checks the issuer, not just the code.
 *
 * This module must stay IMPORT-FREE: the mobile parity harness
 * (`frontend/mobile/lib/__tests__/registryParity.test.ts`) loads it from the
 * mobile-only CI job, where the wallet's node_modules is not installed.
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

/**
 * The registry entry for an asset, but only when BOTH its code (exactly — codes
 * are case-sensitive) and its issuer are the registered ones. A code match on
 * its own is not an asset match; see the module docstring. Mirrors
 * `frontend/mobile/lib/assets.ts` — edit both together.
 */
export function verifiedAsset(
  code: string,
  issuer: string | null | undefined,
  network: 'mainnet' | 'testnet',
): RegisteredAsset | null {
  if (!issuer) return null
  const registered = ASSET_REGISTRY[code.toUpperCase()]
  if (!registered || registered.code !== code) return null
  return isRegisteredIssuer(code, issuer, network) ? registered : null
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

/**
 * Soroban SAC contract IDs for registry assets, per network. Keyed by the
 * *registered* code, so a contract ID resolved through this map always belongs
 * to a verified issuer — the whole point of the map. Mainnet values are the
 * canonical SACs (USDT0's also lives in the registry as `sacContractId`);
 * testnet's is the SDF anchor's USDC.
 */
export const KNOWN_SAC_CONTRACT_IDS: Record<'mainnet' | 'testnet', Record<string, string>> = {
  mainnet: {
    USDC: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
    USDT0: USDT0_MAINNET_SAC,
  },
  testnet: {
    USDC: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  },
}

/**
 * The Soroban SAC contract ID for a registered asset's issuer, or null when the
 * code is not registered on that network or its SAC is not pinned here.
 * Resolved from constants only — no SDK import (see the module docstring);
 * a new registry entry needs its SAC added to `KNOWN_SAC_CONTRACT_IDS` (or a
 * `sacContractId` on its registry entry) rather than deriving one at runtime.
 * Mirrors `frontend/mobile/lib/assets.ts` — edit both together.
 */
export function sacContractIdForCode(code: string, network: 'mainnet' | 'testnet'): string | null {
  const asset = getRegisteredAsset(code, network)
  if (!asset) return null
  if (asset.sacContractId && network === 'mainnet') return asset.sacContractId
  return KNOWN_SAC_CONTRACT_IDS[network][asset.code] ?? null
}

/**
 * Shown when the issuer's flags could not be read at all. `null` has to keep
 * meaning "the flags are clear", so an unreachable Horizon must not collapse
 * into it — otherwise a transient 429 on one of the parallel `loadAccount`
 * calls silently removes the disclosure while the Add button still works.
 */
export const DISCLOSURE_UNAVAILABLE =
  'Could not check whether this issuer can freeze or claw back this balance. Try again before adding a trustline.'

export async function fetchAssetDisclosure(
  server: { loadAccount: (id: string) => Promise<any> },
  issuer: string,
): Promise<string | null> {
  try {
    const account = await server.loadAccount(issuer)
    return getAssetControlDisclosure((account?.flags as HorizonIssuerFlags) ?? null)
  } catch {
    return DISCLOSURE_UNAVAILABLE
  }
}
