import { NETWORK, type StellarNetwork } from './network.js'

/**
 * The assets the agent will call by name, pinned by ISSUER (#821).
 *
 * An asset code is not an identity: anyone can issue an asset called USDC or
 * USDT0, and eight issuers publish a USDT0 on mainnet. A trustline whose code
 * matches an entry here but whose issuer does not is the standard impostor
 * vector, so nothing in the agent may report a holding under a registry label
 * unless {@link isRegisteredIssuer} says the issuer matches too.
 *
 * Mirrors `frontend/mobile/lib/assets.ts`. Every issuer is checked with
 * `StrKey.isValidEd25519PublicKey` in `__tests__/assetRegistry.test.ts`.
 */
export interface RegisteredAsset {
  code: string
  issuer: string
  name: string
  issuerName: string
}

export const USDC_MAINNET_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
export const USDC_TESTNET_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
export const USDY_MAINNET_ISSUER = 'GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6'
export const USDT0_MAINNET_ISSUER = 'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q'

export const ASSET_REGISTRY: Record<StellarNetwork, Record<string, RegisteredAsset>> = {
  mainnet: {
    USDC: { code: 'USDC', issuer: USDC_MAINNET_ISSUER, name: 'USD Coin', issuerName: 'Circle' },
    USDY: { code: 'USDY', issuer: USDY_MAINNET_ISSUER, name: 'Ondo US Dollar Yield', issuerName: 'Ondo Finance' },
    USDT0: { code: 'USDT0', issuer: USDT0_MAINNET_ISSUER, name: 'Tether USD', issuerName: 'Tether' },
  },
  // USDY and USDT0 have no testnet issuer: any testnet holding of those codes is unverified.
  testnet: {
    USDC: { code: 'USDC', issuer: USDC_TESTNET_ISSUER, name: 'USD Coin', issuerName: 'Circle' },
  },
}

/**
 * The registry entry for `code` on `network`, looked up by code alone. Use it
 * only to say what the real asset is — never to label a holding; for that the
 * issuer has to match, via {@link isRegisteredIssuer}.
 */
export function getRegisteredAsset(code: string, network: StellarNetwork = NETWORK): RegisteredAsset | null {
  return ASSET_REGISTRY[network][code.toUpperCase()] ?? null
}

/** Whether `issuer` is the registered issuer of `code` on `network`. */
export function isRegisteredIssuer(code: string, issuer: string, network: StellarNetwork = NETWORK): boolean {
  const entry = getRegisteredAsset(code, network)
  return entry !== null && entry.issuer === issuer
}

/** One issued-asset trustline, as the agent reports it. */
export interface Holding {
  code: string
  /** Always present: the issuer is what identifies the asset. */
  issuer: string
  balance: string
  /** True only when code AND issuer match a registry entry. */
  verified: boolean
  /** Registry name, set only for a verified holding. */
  name?: string
  /** Registry issuer name, set only for a verified holding. */
  issuerName?: string
  /** The line the agent should relay, naming the issuer either way. */
  note: string
}

/** Classify one trustline. Never matches on code alone. */
export function classifyHolding(
  code: string,
  issuer: string,
  balance: string,
  network: StellarNetwork = NETWORK,
): Holding {
  const entry = getRegisteredAsset(code, network)
  if (entry && isRegisteredIssuer(code, issuer, network)) {
    return {
      code,
      issuer,
      balance,
      verified: true,
      name: entry.name,
      issuerName: entry.issuerName,
      note: `${balance} ${entry.code} (${entry.name}), verified: issued by ${entry.issuerName}, ${issuer}.`,
    }
  }
  if (entry) {
    return {
      code,
      issuer,
      balance,
      verified: false,
      note:
        `UNVERIFIED: ${balance} of an asset called ${code} issued by ${issuer}. ` +
        `This is not ${entry.name} — the registered ${entry.code} issuer is ${entry.issuer}. Do not call it ${entry.code}.`,
    }
  }
  return {
    code,
    issuer,
    balance,
    verified: false,
    note: `UNVERIFIED: ${balance} ${code} issued by ${issuer}. This asset is not in Veil's registry.`,
  }
}
