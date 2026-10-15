import { Networks } from '@stellar/stellar-sdk'

/**
 * Which Stellar network this agent serves, and every endpoint that follows
 * from it — decided in one place.
 *
 * Each module used to read its own env vars with its own testnet default. So
 * STELLAR_NETWORK=mainnet signed transactions for mainnet while balances,
 * history and account loads still came from testnet Horizon. Now one variable
 * picks the network and the endpoints come with it; the URL variables only
 * override individual endpoints.
 *
 * Mainnet by default, because that is where Veil's users are. Run a second
 * instance with STELLAR_NETWORK=testnet for testnet.
 */
export type StellarNetwork = 'mainnet' | 'testnet'

// NEXT_PUBLIC_NETWORK is the wallet app's setting: when the agent runs inside
// the wallet's own API route, it follows the wallet's network unless told
// otherwise, so a testnet preview deploy never answers with mainnet balances.
const configuredNetwork = (process.env.STELLAR_NETWORK ?? process.env.NEXT_PUBLIC_NETWORK)
  ?.trim()
  .toLowerCase()

export const NETWORK: StellarNetwork = configuredNetwork === 'testnet' ? 'testnet' : 'mainnet'

const DEFAULTS = {
  mainnet: {
    passphrase: Networks.PUBLIC,
    horizonUrl: 'https://horizon.stellar.org',
    // SDF runs no public mainnet RPC. This is Veil's own proxy, which fails over
    // across several providers — the same one the web and mobile apps use.
    sorobanRpcUrl: 'https://app.useveilapp.xyz/api/rpc/mainnet',
    usdcIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  },
  testnet: {
    passphrase: Networks.TESTNET,
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    usdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  },
} as const

const d = DEFAULTS[NETWORK]

export const NETWORK_PASSPHRASE: string = d.passphrase
export const HORIZON_URL = process.env.HORIZON_URL?.trim() || d.horizonUrl
export const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL?.trim() || d.sorobanRpcUrl

/** USDC's issuer on this network, so a bare "USDC" names one specific asset. */
export const USDC_ISSUER: string = d.usdcIssuer
