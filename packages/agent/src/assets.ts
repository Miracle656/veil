import { Asset, Networks, StrKey } from '@stellar/stellar-sdk'
import { NETWORK, USDC_ISSUER, type StellarNetwork } from './network.js'

/**
 * Assets the agent will vouch for, keyed by code and pinned by ISSUER.
 *
 * An asset code is not an identity. Eight different issuers publish `USDT0` on
 * mainnet, and the genuine one is the only one without a stellar.toml, so a
 * code match is seven-to-one against you. Nothing here (or anywhere in the
 * agent) may call a holding "verified" because its code matches; the issuer
 * has to match too.
 */
export interface VerifiedAsset {
  code: string
  issuer: string
  /** Stellar Asset Contract id, only where it is pinned and asserted in tests. */
  sac?: string
  name: string
  /** What the issuer can do to a holder, when the agent should say so. */
  issuerControls?: { clawback: boolean; freeze: boolean }
}

// Verified against mainnet Horizon on 2026-09-24 (issue #795). The SAC is
// derived from the issuer rather than trusted as pasted.
export const USDT0_MAINNET_ISSUER = 'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q'
export const USDT0_MAINNET_SAC = 'CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF'

function USDC_ISSUER_FOR(network: StellarNetwork): string {
  // network.ts holds the current network's USDC issuer; the other network's is fixed.
  if (network === NETWORK) return USDC_ISSUER
  return network === 'mainnet'
    ? 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
    : 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
}

const REGISTRY: Record<StellarNetwork, Record<string, VerifiedAsset>> = {
  mainnet: {
    USDT0: {
      code: 'USDT0',
      issuer: USDT0_MAINNET_ISSUER,
      sac: new Asset('USDT0', USDT0_MAINNET_ISSUER).contractId(Networks.PUBLIC),
      name: 'USDT0',
      issuerControls: { clawback: true, freeze: true },
    },
    USDC: { code: 'USDC', issuer: USDC_ISSUER_FOR('mainnet'), name: 'USD Coin' },
  },
  // There is no verified USDT0 on testnet: any holding of that code is unverified.
  testnet: {
    USDC: { code: 'USDC', issuer: USDC_ISSUER_FOR('testnet'), name: 'USD Coin' },
  },
}

/**
 * Every registered entry, flattened, so a test can assert over all of them
 * rather than over the handful that happen to be exported as constants.
 *
 * This exists because an invalid issuer has reached a PR four times. The
 * checks that should have caught it did not: the parity tests compare the
 * three copies of the registry to each other, so an address that is wrong
 * identically in all three passes, and the per-constant StrKey assertions
 * only cover the constants someone remembered to add. Iterating the registry
 * means a *new* asset is covered the moment it is added, by nobody's
 * discipline.
 */
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
  /** For verified and unverified holdings: the issuer the registry knows. */
  registeredIssuer?: string
  /** Plain-language line the agent should relay. */
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
