/**
 * Anchor directory & SEP-1 / SEP-6 / SEP-24 discovery engine for Veil wallet.
 * https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0001.md
 * https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md
 * https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md
 */

import {
  Keypair,
  Networks,
  Operation,
  StrKey,
  StellarToml,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk'

// ── Verified Asset Registry (Pinning Known Assets) ────────────────────────────

export interface VerifiedAsset {
  code: string
  issuer: string
  name: string
  issuerName: string
  homeDomain: string
  kind: 'treasury' | 'fund' | 'equity' | 'stablecoin' | 'utility'
}

/** Pinned, verified assets on Stellar mainnet & testnet. */
export const VERIFIED_ASSET_REGISTRY: Record<string, VerifiedAsset> = {
  USDC: {
    code: 'USDC',
    issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335WFGCCHVTLF2CCZAK27ZQQ625',
    name: 'USD Coin',
    issuerName: 'Circle',
    homeDomain: 'centre.io',
    kind: 'stablecoin',
  },
  EURC: {
    code: 'EURC',
    issuer: 'GDHU6WR2KCEVDLWBVRWXZVH2AZ3ZX4BH4AXSSOQNTFQC2V3CQE37K3VC',
    name: 'Euro Coin',
    issuerName: 'Circle',
    homeDomain: 'circle.com',
    kind: 'stablecoin',
  },
  USDY: {
    code: 'USDY',
    issuer: 'GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6',
    name: 'Ondo US Dollar Yield',
    issuerName: 'Ondo Finance',
    homeDomain: 'ondo.finance',
    kind: 'treasury',
  },
}

// ── Types for Anchor Directory ────────────────────────────────────────────────

export interface DiscoveredCurrency {
  code: string
  issuer?: string
  name?: string
  desc?: string
  image?: string
  status?: string
  isAssetAnchored?: boolean
  anchorAssetType?: string
  anchorAsset?: string
  sep24Enabled?: boolean
  sep6Enabled?: boolean
  depositEnabled?: boolean
  withdrawEnabled?: boolean
  /** Whether the issuer was verified against TOML ACCOUNTS/ISSUERS or valid format */
  isIssuerVerified: boolean
  /** Whether this currency matches the verified registry pinned issuer */
  isVerifiedRegistry: boolean
  /** Flagged if code matches a known asset code but issuer does NOT match pinned issuer */
  isImpersonating?: boolean
  verifiedIssuer?: string
}

export interface DiscoveredAnchorInfo {
  homeDomain: string
  transferServerSep24?: string
  transferServerSep6?: string
  webAuthEndpoint?: string
  kycServer?: string
  networkPassphrase?: string
  accounts: string[]
  currencies: DiscoveredCurrency[]
}

// ── Case-insensitive TOML field helper ───────────────────────────────────────

function getTomlField(obj: Record<string, any>, key: string): any {
  if (!obj || typeof obj !== 'object') return undefined
  if (key in obj) return obj[key]
  const lower = key.toLowerCase()
  if (lower in obj) return obj[lower]
  const upper = key.toUpperCase()
  if (upper in obj) return obj[upper]
  const foundKey = Object.keys(obj).find((k) => k.toLowerCase() === lower)
  return foundKey ? obj[foundKey] : undefined
}

// ── Pure TOML String Parser (Robust & Standalone) ─────────────────────────────

function stripTomlComment(str: string): string {
  let inQuotes = false
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '"') inQuotes = !inQuotes
    if (str[i] === '#' && !inQuotes) {
      return str.slice(0, i).trim()
    }
  }
  return str.trim()
}

export async function parseTomlString(tomlText: string): Promise<Record<string, any>> {
  if (!tomlText || typeof tomlText !== 'string') return {}

  try {
    const sdkParsed = (StellarToml as any).parse?.(tomlText)
    if (sdkParsed) {
      const res = typeof sdkParsed.then === 'function' ? await sdkParsed : sdkParsed
      if (res && typeof res === 'object' && Object.keys(res).length > 0) {
        return res
      }
    }
  } catch {
    // Fallback to custom parser below
  }

  const result: Record<string, any> = {}
  let currentSection: Record<string, any> | null = null
  let currentArrayName: string | null = null

  const lines = tomlText.split(/\r?\n/)
  for (let line of lines) {
    line = stripTomlComment(line)
    if (!line) continue

    // [[CURRENCIES]]
    const arrayMatch = line.match(/^\[\[\s*([a-zA-Z0-9_-]+)\s*\]\]$/)
    if (arrayMatch) {
      currentArrayName = arrayMatch[1].toUpperCase()
      if (!result[currentArrayName]) {
        result[currentArrayName] = []
      }
      currentSection = {}
      result[currentArrayName].push(currentSection)
      continue
    }

    // [SECTION]
    const sectionMatch = line.match(/^\[\s*([a-zA-Z0-9_-]+)\s*\]$/)
    if (sectionMatch) {
      currentArrayName = null
      const secName = sectionMatch[1].toUpperCase()
      result[secName] = result[secName] || {}
      currentSection = result[secName]
      continue
    }

    // Key = Value
    const kvMatch = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*(.+)$/)
    if (kvMatch) {
      const key = kvMatch[1].toUpperCase()
      const valStr = kvMatch[2].trim()

      let parsedVal: any = valStr
      if (valStr.startsWith('"') && valStr.endsWith('"')) {
        parsedVal = valStr.slice(1, -1)
      } else if (valStr.startsWith('[') && valStr.endsWith(']')) {
        try {
          const inner = valStr.slice(1, -1)
          parsedVal = inner
            .split(',')
            .map((s) => s.trim().replace(/^"/, '').replace(/"$/, ''))
            .filter(Boolean)
        } catch {
          parsedVal = []
        }
      } else if (valStr === 'true') {
        parsedVal = true
      } else if (valStr === 'false') {
        parsedVal = false
      } else if (!isNaN(Number(valStr))) {
        parsedVal = Number(valStr)
      }

      if (currentSection) {
        currentSection[key] = parsedVal
      } else {
        result[key] = parsedVal
      }
    }
  }

  return result
}

// ── SEP-1 TOML Parsing & Verification ─────────────────────────────────────────

/**
 * Validates whether a string is a valid Stellar Ed25519 Public Key (G...)
 */
export function isValidStellarPublicKey(key: string): boolean {
  if (!key || typeof key !== 'string') return false
  return StrKey.isValidEd25519PublicKey(key)
}

/**
 * Validates asset code: 1 to 12 alphanumeric characters.
 */
export function isValidAssetCode(code: string): boolean {
  if (!code || typeof code !== 'string') return false
  return /^[a-zA-Z0-9]{1,12}$/.test(code)
}

/**
 * Safely parses a `stellar.toml` file (SEP-1) and extracts currencies + endpoints
 * with strict issuer verification.
 */
export async function parseAnchorToml(tomlText: string, domain: string): Promise<DiscoveredAnchorInfo> {
  if (!tomlText || typeof tomlText !== 'string') {
    return { homeDomain: domain, accounts: [], currencies: [] }
  }

  let parsed: Record<string, any> = {}
  try {
    parsed = await parseTomlString(tomlText)
  } catch {
    return { homeDomain: domain, accounts: [], currencies: [] }
  }

  // Endpoints (case-insensitive lookups)
  const rawSep24 = getTomlField(parsed, 'TRANSFER_SERVER_SEP0024')
  const transferServerSep24 = typeof rawSep24 === 'string' ? rawSep24.replace(/\/$/, '') : undefined

  const rawSep6 = getTomlField(parsed, 'TRANSFER_SERVER')
  const transferServerSep6 = typeof rawSep6 === 'string' ? rawSep6.replace(/\/$/, '') : undefined

  const rawWebAuth = getTomlField(parsed, 'WEB_AUTH_ENDPOINT')
  const webAuthEndpoint = typeof rawWebAuth === 'string' ? rawWebAuth.replace(/\/$/, '') : undefined

  const rawKyc = getTomlField(parsed, 'KYC_SERVER')
  const kycServer = typeof rawKyc === 'string' ? rawKyc.replace(/\/$/, '') : undefined

  const rawNetwork = getTomlField(parsed, 'NETWORK_PASSPHRASE')
  const networkPassphrase = typeof rawNetwork === 'string' ? rawNetwork : undefined

  // Declared accounts / issuers in TOML
  const accounts: string[] = []
  const rawAccountsField = getTomlField(parsed, 'ACCOUNTS') ?? getTomlField(parsed, 'ISSUERS')
  const rawAccountSingle = getTomlField(parsed, 'STELLAR_ACCOUNT')

  const rawAccounts = Array.isArray(rawAccountsField)
    ? rawAccountsField
    : typeof rawAccountSingle === 'string'
      ? [rawAccountSingle]
      : []

  for (const acc of rawAccounts) {
    if (typeof acc === 'string' && isValidStellarPublicKey(acc.trim())) {
      accounts.push(acc.trim())
    }
  }

  // Parse Currencies
  const currencies: DiscoveredCurrency[] = []
  const rawCurrencies = getTomlField(parsed, 'CURRENCIES')
  const currenciesList = Array.isArray(rawCurrencies) ? rawCurrencies : []

  for (const item of currenciesList) {
    if (!item || typeof item !== 'object') continue

    const codeVal = getTomlField(item, 'code')
    const issuerVal = getTomlField(item, 'issuer')

    const code = typeof codeVal === 'string' ? codeVal.trim() : ''
    const issuer = typeof issuerVal === 'string' ? issuerVal.trim() : undefined

    // Must have a valid code
    if (!isValidAssetCode(code) && code !== 'XLM') continue

    // Issuer verification:
    // If native XLM: valid without issuer.
    // If token: issuer must be a valid Stellar public key.
    const isIssuerValidKey = code === 'XLM' || (Boolean(issuer) && isValidStellarPublicKey(issuer!))

    if (!isIssuerValidKey) continue

    // If TOML explicitly listed ACCOUNTS/ISSUERS, check if currency's issuer is declared there
    const matchesTomlAccounts = accounts.length === 0 || (issuer ? accounts.includes(issuer) : true)

    const isIssuerVerified = isIssuerValidKey && matchesTomlAccounts

    // Check against verified asset registry
    const registryAsset = VERIFIED_ASSET_REGISTRY[code]
    let isVerifiedRegistry = false
    let isImpersonating = false
    let verifiedIssuer: string | undefined = undefined

    if (registryAsset) {
      verifiedIssuer = registryAsset.issuer
      if (issuer && issuer === registryAsset.issuer) {
        isVerifiedRegistry = true
      } else if (issuer && issuer !== registryAsset.issuer) {
        isImpersonating = true
        isVerifiedRegistry = false
      }
    }

    const nameVal = getTomlField(item, 'name')
    const descVal = getTomlField(item, 'desc')
    const imageVal = getTomlField(item, 'image')
    const statusVal = getTomlField(item, 'status')
    const isAnchoredVal = getTomlField(item, 'is_asset_anchored')
    const anchorTypeVal = getTomlField(item, 'anchor_asset_type')
    const anchorAssetVal = getTomlField(item, 'anchor_asset')
    const sep24EnabledVal = getTomlField(item, 'sep24_enabled')
    const sep6EnabledVal = getTomlField(item, 'sep6_enabled')
    const depositEnabledVal = getTomlField(item, 'deposit_enabled')
    const withdrawEnabledVal = getTomlField(item, 'withdraw_enabled')

    currencies.push({
      code,
      issuer,
      name: typeof nameVal === 'string' ? nameVal : undefined,
      desc: typeof descVal === 'string' ? descVal : undefined,
      image: typeof imageVal === 'string' ? imageVal : undefined,
      status: typeof statusVal === 'string' ? statusVal : undefined,
      isAssetAnchored: Boolean(isAnchoredVal),
      anchorAssetType: typeof anchorTypeVal === 'string' ? anchorTypeVal : undefined,
      anchorAsset: typeof anchorAssetVal === 'string' ? anchorAssetVal : undefined,
      sep24Enabled: sep24EnabledVal !== false,
      sep6Enabled: Boolean(sep6EnabledVal),
      depositEnabled: depositEnabledVal !== false,
      withdrawEnabled: withdrawEnabledVal !== false,
      isIssuerVerified,
      isVerifiedRegistry,
      isImpersonating,
      verifiedIssuer,
    })
  }

  return {
    homeDomain: domain,
    transferServerSep24,
    transferServerSep6,
    webAuthEndpoint,
    kycServer,
    networkPassphrase,
    accounts,
    currencies,
  }
}

/**
 * Fetch and parse `stellar.toml` for a domain over HTTPS.
 */
export async function fetchAnchorToml(
  domain: string,
  fetchFn: typeof fetch = fetch,
): Promise<DiscoveredAnchorInfo> {
  const cleanDomain = domain.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  if (!cleanDomain) {
    throw new Error('Domain cannot be empty')
  }

  const url = `https://${cleanDomain}/.well-known/stellar.toml`
  let res: Response
  try {
    res = await fetchFn(url, { signal: AbortSignal.timeout(10_000) })
  } catch (err) {
    throw new Error(`Could not fetch stellar.toml from ${cleanDomain}: ${(err as Error).message}`)
  }

  if (!res.ok) {
    throw new Error(`Could not fetch stellar.toml from ${cleanDomain} (HTTP ${res.status})`)
  }

  const text = await res.text()
  return parseAnchorToml(text, cleanDomain)
}

// ── Malformed / Hostile TOML Defense for Asset Registry ───────────────────────

export class HostileTomlInjectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostileTomlInjectionError'
  }
}

/**
 * Guarantees that a malformed or hostile TOML cannot inject an asset into the
 * verified registry.
 * Returns true if the asset is legitimate and safe to register.
 * Throws `HostileTomlInjectionError` if the asset is unverified or impersonating.
 */
export function registerDiscoveredAsset(
  asset: DiscoveredCurrency,
  registry: Record<string, VerifiedAsset> = VERIFIED_ASSET_REGISTRY,
): boolean {
  if (!asset.isIssuerVerified) {
    throw new HostileTomlInjectionError(
      `Cannot register asset ${asset.code}: issuer verification failed.`,
    )
  }

  if (asset.isImpersonating) {
    throw new HostileTomlInjectionError(
      `Cannot register asset ${asset.code}: issuer ${asset.issuer} impersonates registered issuer ${asset.verifiedIssuer}.`,
    )
  }

  const existing = registry[asset.code]
  if (existing && asset.issuer !== existing.issuer) {
    throw new HostileTomlInjectionError(
      `Hostile injection blocked: ${asset.code} issuer ${asset.issuer} does not match verified registry ${existing.issuer}.`,
    )
  }

  return true
}

// ── SEP-10 Auth & Privacy Enforcer ───────────────────────────────────────────

export interface Sep10AuthOptions {
  webAuthEndpoint: string
  account: string
  networkPassphrase?: string
  signerKeypair: Keypair
  fetchFn?: typeof fetch
}

/**
 * Authenticate against a testnet/mainnet anchor via SEP-10 using user's key.
 * Enforces zero data leakage: ONLY the challenge signature is sent to the anchor.
 */
export async function authenticateSep10({
  webAuthEndpoint,
  account,
  networkPassphrase = Networks.TESTNET,
  signerKeypair,
  fetchFn = fetch,
}: Sep10AuthOptions): Promise<string> {
  // 1. Fetch challenge
  const challengeUrl = `${webAuthEndpoint}?account=${encodeURIComponent(account)}`
  const challengeRes = await fetchFn(challengeUrl, { signal: AbortSignal.timeout(10_000) })
  if (!challengeRes.ok) {
    const errText = await challengeRes.text().catch(() => challengeRes.statusText)
    throw new Error(`SEP-10 challenge fetch failed (HTTP ${challengeRes.status}): ${errText}`)
  }

  const { transaction: challengeXdr, network_passphrase } = (await challengeRes.json()) as {
    transaction: string
    network_passphrase?: string
  }

  if (!challengeXdr) {
    throw new Error('Anchor challenge response missing transaction XDR')
  }

  const effectivePassphrase = network_passphrase || networkPassphrase

  // 2. Parse & sign challenge
  let tx: Transaction
  try {
    tx = new Transaction(challengeXdr, effectivePassphrase)
  } catch (err) {
    throw new Error(`Failed to parse SEP-10 challenge XDR: ${(err as Error).message}`)
  }

  // SEP-10 validation checks
  const manageDataOps = tx.operations.filter(
    (op): op is Operation.ManageData => op.type === 'manageData',
  )
  if (manageDataOps.length === 0) {
    throw new Error('SEP-10 challenge must contain at least one manage_data operation')
  }

  if (!tx.timeBounds) {
    throw new Error('SEP-10 challenge must have timeBounds set')
  }

  const nowSec = Math.floor(Date.now() / 1000)
  const maxTime = Number(tx.timeBounds.maxTime)
  if (maxTime > 0 && nowSec > maxTime) {
    throw new Error(`SEP-10 challenge has expired (maxTime=${maxTime}, now=${nowSec})`)
  }

  const rebuilt = TransactionBuilder.cloneFrom(tx).build()
  rebuilt.sign(signerKeypair)
  const signedXdr = rebuilt.toXDR()

  // 3. Post back ONLY transaction XDR for JWT (zero user data transmitted)
  const tokenRes = await fetchFn(webAuthEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transaction: signedXdr }),
    signal: AbortSignal.timeout(15_000),
  })

  if (!tokenRes.ok) {
    const errText = await tokenRes.text().catch(() => tokenRes.statusText)
    throw new Error(`SEP-10 token exchange failed (HTTP ${tokenRes.status}): ${errText}`)
  }

  const data = (await tokenRes.json()) as { token?: string }
  if (!data.token) {
    throw new Error('Anchor did not return a JWT token.')
  }

  return data.token
}
