import { Asset, Networks, StrKey } from '@stellar/stellar-sdk'
import { NETWORK, USDC_ISSUER, type StellarNetwork } from './network.js'

/**
 * Verified asset registry (V176) mapping short token keys to exact issuer addresses
 * and metadata.
 *
 * A code alone is not an asset: mainnet has eight assets called USDT0 and seven
 * are impostors. Anything that names, badges, prices or classifies an asset
 * must go through `verifiedAsset`, which checks the issuer, not just the code.
 */

export interface RegisteredAsset {
  code: string
  issuer: string
  name: string
  issuerName: string
  homeDomain?: string
  network: 'mainnet' | 'testnet' | 'all'
  kind: 'treasury' | 'fund' | 'equity' | 'governance' | 'stablecoin' | 'native'
  reserveXlm?: number
  sacContractId?: string
}

/** Stellar uses alphanum4 for codes up to 4 chars and alphanum12 thereafter. */
export function stellarAssetTypeForCode(code: string): 'credit_alphanum4' | 'credit_alphanum12' {
  if (!/^[A-Za-z0-9]{1,12}$/.test(code)) {
    throw new Error('Stellar asset codes must contain 1 to 12 alphanumeric characters.')
  }
  return code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12'
}

export const USDY_MAINNET_ISSUER = 'GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6'
export const USDC_MAINNET_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
export const USDC_TESTNET_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
export const EURC_MAINNET_ISSUER = 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2'
export const AQUA_MAINNET_ISSUER = 'GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA'
export const USDT0_MAINNET_ISSUER = 'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q'
export const USDT0_MAINNET_SAC = 'CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF'
export const ETHERFUSE_MAINNET_ISSUER = 'GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC'

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
  // AQUA floats and is priced from the order book, never from a hardcoded rate.
  AQUA: {
    code: 'AQUA',
    issuer: AQUA_MAINNET_ISSUER,
    name: 'Aquarius',
    issuerName: 'Aquarius',
    homeDomain: 'aqua.network',
    network: 'mainnet',
    kind: 'governance',
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
  CETES: {
    code: 'CETES',
    issuer: ETHERFUSE_MAINNET_ISSUER,
    name: 'Mexican Treasury Certificates',
    issuerName: 'Etherfuse',
    homeDomain: 'etherfuse.com',
    network: 'mainnet',
    kind: 'treasury',
  },
  USTRY: {
    code: 'USTRY',
    issuer: ETHERFUSE_MAINNET_ISSUER,
    name: 'US Treasury Notes',
    issuerName: 'Etherfuse',
    homeDomain: 'etherfuse.com',
    network: 'mainnet',
    kind: 'treasury',
  },
  TESOURO: {
    code: 'TESOURO',
    issuer: ETHERFUSE_MAINNET_ISSUER,
    name: 'Brazilian Treasury',
    issuerName: 'Etherfuse',
    homeDomain: 'etherfuse.com',
    network: 'mainnet',
    kind: 'treasury',
  },
}

export function getRegisteredAsset(
  code: string,
  issuerOrNetwork?: string | null,
): RegisteredAsset | null {
  const upperCode = code.toUpperCase()
  const asset = ASSET_REGISTRY[upperCode]
  if (!asset) return null

  if (issuerOrNetwork === undefined) return asset

  if (issuerOrNetwork === 'mainnet' || issuerOrNetwork === 'testnet') {
    if (asset.network !== 'all' && asset.network !== issuerOrNetwork) {
      return null
    }
    return asset
  }

  if (upperCode === 'XLM' || asset.kind === 'native') {
    if (!issuerOrNetwork || issuerOrNetwork === '' || issuerOrNetwork === 'native') {
      return asset
    }
    return null
  }

  if (upperCode === 'USDC' && issuerOrNetwork === USDC_TESTNET_ISSUER) {
    return asset
  }

  return asset.issuer === issuerOrNetwork ? asset : null
}

export function getAssetIssuer(code: string, network: 'mainnet' | 'testnet' = 'mainnet'): string | null {
  if (code.toUpperCase() === 'USDC' && network === 'testnet') {
    return USDC_TESTNET_ISSUER
  }
  const asset = getRegisteredAsset(code, network)
  if (!asset) return null
  if (asset.network === 'mainnet' && network === 'testnet') {
    return null
  }
  return asset.issuer
}

export function isRegisteredIssuer(
  code: string,
  issuer: string,
  network: 'mainnet' | 'testnet' = 'mainnet',
): boolean {
  const upperCode = code.toUpperCase()
  if (upperCode === 'XLM') {
    return !issuer || issuer === '' || issuer === 'native'
  }
  if (upperCode === 'USDC') {
    return issuer === USDC_MAINNET_ISSUER || issuer === USDC_TESTNET_ISSUER
  }
  const asset = ASSET_REGISTRY[upperCode]
  if (!asset) return false
  if (asset.network === 'mainnet' && network === 'testnet') {
    return false
  }
  return asset.issuer === issuer
}

export function verifiedAsset(
  code: string,
  issuer: string | null | undefined,
  network: 'mainnet' | 'testnet' = 'mainnet',
): RegisteredAsset | null {
  if (!issuer) {
    if (code.toUpperCase() === 'XLM') return ASSET_REGISTRY.XLM
    return null
  }
  const registered = ASSET_REGISTRY[code.toUpperCase()]
  if (!registered || registered.code !== code) return null
  return isRegisteredIssuer(code, issuer, network) ? registered : null
}

export function formatAssetLabel(
  code: string,
  issuer?: string | null,
  network: 'mainnet' | 'testnet' = 'mainnet',
): string {
  const asset = verifiedAsset(code, issuer, network) ?? (code.toUpperCase() === 'XLM' ? ASSET_REGISTRY.XLM : null)
  if (asset) return asset.code

  const shortIssuer = issuer ? `${issuer.slice(0, 4)}…` : 'unknown'
  return `Unverified: ${code.toUpperCase()} (issuer ${shortIssuer})`
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

export const KNOWN_SAC_CONTRACT_IDS: Record<'mainnet' | 'testnet', Record<string, string>> = {
  mainnet: {
    USDC: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
    USDT0: USDT0_MAINNET_SAC,
  },
  testnet: {
    USDC: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  },
}

export function sacContractIdForCode(code: string, network: 'mainnet' | 'testnet'): string | null {
  const asset = getRegisteredAsset(code, network)
  if (!asset) return null
  if (asset.sacContractId && network === 'mainnet') return asset.sacContractId
  return KNOWN_SAC_CONTRACT_IDS[network][asset.code] ?? null
}

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

/**
 * Assets the agent will vouch for, keyed by code and pinned by ISSUER.
 */
export interface VerifiedAsset {
  code: string
  issuer: string
  sac?: string
  name: string
  issuerControls?: { clawback: boolean; freeze: boolean }
}

const REGISTRY: Record<StellarNetwork, Record<string, VerifiedAsset>> = {
  mainnet: {
    USDT0: {
      code: 'USDT0',
      issuer: USDT0_MAINNET_ISSUER,
      sac: USDT0_MAINNET_SAC,
      name: 'USDT0',
      issuerControls: { clawback: true, freeze: true },
    },
    USDC: { code: 'USDC', issuer: USDC_MAINNET_ISSUER, name: 'USD Coin' },
    USDY: { code: 'USDY', issuer: USDY_MAINNET_ISSUER, name: 'Ondo US Dollar Yield' },
    EURC: { code: 'EURC', issuer: EURC_MAINNET_ISSUER, name: 'EUR Coin' },
    AQUA: { code: 'AQUA', issuer: AQUA_MAINNET_ISSUER, name: 'Aquarius' },
    CETES: { code: 'CETES', issuer: ETHERFUSE_MAINNET_ISSUER, name: 'Mexican Treasury Certificates' },
    USTRY: { code: 'USTRY', issuer: ETHERFUSE_MAINNET_ISSUER, name: 'US Treasury Notes' },
    TESOURO: { code: 'TESOURO', issuer: ETHERFUSE_MAINNET_ISSUER, name: 'Brazilian Treasury' },
  },
  testnet: {
    USDC: { code: 'USDC', issuer: USDC_TESTNET_ISSUER, name: 'USD Coin' },
  },
}

export const ALL_REGISTERED_ASSETS: ReadonlyArray<{
  network: StellarNetwork
  asset: VerifiedAsset
}> = (Object.keys(REGISTRY) as StellarNetwork[]).flatMap((network) =>
  Object.values(REGISTRY[network]).map((asset) => ({ network, asset })),
)

/** Registered entry for a code on this network, if any. */
export function registeredAsset(code: string, network: StellarNetwork = NETWORK): VerifiedAsset | null {
  return REGISTRY[network][code.trim().toUpperCase()] ?? null
}

export type HoldingStatus =
  | 'verified' // code and issuer both match a registered asset
  | 'unverified' // the code is registered but this issuer is not the registered one
  | 'unlisted' // the code is not in the registry, so nothing is claimed about it

export interface Holding {
  code: string
  issuer: string
  balance: string
  status: HoldingStatus
  registeredIssuer?: string
  message: string
}

const short = (issuer: string) => `${issuer.slice(0, 6)}…${issuer.slice(-6)}`

/** Classify one issued-asset holding. The issuer is always named in the message. */
export function classifyHolding(
  code: string,
  issuer: string,
  balance: string,
  network: StellarNetwork = NETWORK,
): Holding {
  const entry = registeredAsset(code, network)
  const upper = code.toUpperCase()
  if (!entry) {
    return {
      code,
      issuer,
      balance,
      status: 'unlisted',
      message: `${balance} ${code} from issuer ${issuer}. This asset is not in Veil's registry, so it is not verified.`,
    }
  }
  if (entry.issuer === issuer) {
    return {
      code,
      issuer,
      balance,
      status: 'verified',
      registeredIssuer: entry.issuer,
      message: `${balance} ${upper}, verified: issued by ${issuer}.`,
    }
  }
  return {
    code,
    issuer,
    balance,
    status: 'unverified',
    registeredIssuer: entry.issuer,
    message:
      `UNVERIFIED: ${balance} of an asset called ${upper} issued by ${issuer}. ` +
      `This is not the real ${upper} (the verified issuer is ${entry.issuer}); several issuers reuse the same code. ` +
      `Do not treat it as ${upper}.`,
  }
}

/**
 * Turn the `CODE:ISSUER` entries of a getBalances() result into classified
 * holdings. XLM entries (no issuer) are skipped. Never matches on code alone.
 */
export function classifyBalances(balances: Record<string, string>, network: StellarNetwork = NETWORK): Holding[] {
  const holdings: Holding[] = []
  for (const [key, balance] of Object.entries(balances)) {
    const sep = key.indexOf(':')
    if (sep === -1) continue
    const code = key.slice(0, sep)
    const issuer = key.slice(sep + 1)
    if (!code || !StrKey.isValidEd25519PublicKey(issuer)) continue
    holdings.push(classifyHolding(code, issuer, balance, network))
  }
  return holdings
}

export interface AssetAnswer {
  asset: string
  status: HoldingStatus | 'unknown'
  issuer?: string
  sac?: string
  message: string
  issuerControls?: { clawback: boolean; freeze: boolean }
}

/**
 * Answer "what is <asset>?". Accepts `CODE` or `CODE:ISSUER`. With a bare code
 * it names the verified issuer and warns that the code alone proves nothing;
 * with an issuer it says whether that issuer is the registered one.
 */
export function describeAsset(input: string, network: StellarNetwork = NETWORK): AssetAnswer {
  const [rawCode, rawIssuer] = input.trim().split(':')
  const code = rawCode.trim()
  const entry = registeredAsset(code, network)
  if (!entry) {
    return {
      asset: input,
      status: 'unknown',
      message: `${code} is not in Veil's asset registry on ${network}, so its issuer cannot be verified.`,
    }
  }
  const controls = entry.issuerControls
  const powers = controls
    ? [controls.freeze && 'freeze a trustline', controls.clawback && 'claw back a balance'].filter(Boolean)
    : []
  const controlsText = powers.length
    ? ` Its issuer can ${powers.join(' and ')}, so holdings are not censorship-resistant.`
    : ''
  const base = `The verified ${entry.code} on ${network} is issued by ${entry.issuer}${entry.sac ? ` (contract ${entry.sac})` : ''}.${controlsText} Other issuers publish assets with the same code; only this issuer is the real one.`
  if (rawIssuer) {
    const issuer = rawIssuer.trim()
    const holding = classifyHolding(entry.code, issuer, '', network)
    return {
      asset: input,
      status: holding.status,
      issuer,
      message:
        holding.status === 'verified'
          ? `${entry.code} from ${issuer} is the verified asset. ${base}`
          : `${entry.code} from ${issuer} is UNVERIFIED and is not the real ${entry.code}. ${base}`,
      issuerControls: controls,
    }
  }
  return {
    asset: input,
    status: 'verified',
    issuer: entry.issuer,
    ...(entry.sac ? { sac: entry.sac } : {}),
    message: base,
    issuerControls: controls,
  }
}

/** Derive the SAC for a registered asset, for tests to compare against the pinned id. */
export function deriveSac(asset: VerifiedAsset, passphrase: string = Networks.PUBLIC): string {
  return new Asset(asset.code, asset.issuer).contractId(passphrase)
}
