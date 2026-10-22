import { Asset, Networks } from '@stellar/stellar-sdk'
import type { WalletConfig } from 'invisible-wallet-sdk/vanilla'
import type { PublicEnv } from './config.server'

/**
 * Derives Stellar network details + the SDK {@link WalletConfig} from the public
 * env. Works on both the server (pass `getPublicEnv()`) and the client (pass
 * `window.ENV`), so loaders/actions and components share one source of truth.
 */
export function resolveNetwork(env: PublicEnv) {
  const isMainnet = env.NETWORK === 'mainnet'
  const networkPassphrase = isMainnet ? Networks.PUBLIC : Networks.TESTNET

  const walletConfig: WalletConfig = {
    factoryAddress: env.FACTORY_CONTRACT_ID,
    rpcUrl: env.SOROBAN_RPC_URL,
    networkPassphrase,
  }

  return {
    isMainnet,
    networkPassphrase,
    rpcUrl: env.SOROBAN_RPC_URL,
    horizonUrl: env.HORIZON_URL,
    friendbotUrl: isMainnet ? null : 'https://friendbot.stellar.org',
    walletConfig,
    nativeAssetContractId: () => Asset.native().contractId(networkPassphrase),
  }
}

/** Read the public env the root loader injected onto `window`. Client-only. */
export function clientEnv(): PublicEnv {
  if (typeof window === 'undefined' || !window.ENV) {
    throw new Error('window.ENV is not set — is the root loader exposing it?')
  }
  return window.ENV
}

/**
 * Resolves an unconfirmed money action once connectivity returns.
 *
 * An action is "unconfirmed" when the passkey ceremony completed but the
 * network dropped before the submitted transaction could be confirmed. The
 * user may already have been charged, so the screen must never report a failure
 * it cannot prove. This helper looks the transaction up by hash and reports
 * what the network actually says.
 */
export type UnconfirmedResolution =
  | { status: 'confirmed'; hash: string }
  | { status: 'not_found'; hash: string }
  | { status: 'still_unconfirmed'; hash: string }

export async function resolveUnconfirmedAction(
  hash: string,
  env: PublicEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<UnconfirmedResolution> {
  const { horizonUrl } = resolveNetwork(env)
  const url = `${horizonUrl.replace(/\/$/, '')}/transactions/${encodeURIComponent(hash)}`

  let response: Response
  try {
    response = await fetchImpl(url, { headers: { Accept: 'application/json' } })
  } catch {
    // Still offline (e.g. reconnect fired against a flapping link). The
    // user is neither confirmed nor failed; keep the unconfirmed state.
    return { status: 'still_unconfirmed', hash }
  }

  if (response.status === 404) {
    // Horizon has no record of the hash. The submission never reached the
    // network, so the user was not charged.
    return { status: 'not_found', hash }
  }

  if (!response.ok) {
    // Any other non-success (gateway, 5xx) means we cannot prove anything.
    return { status: 'still_unconfirmed', hash }
  }

  const body = (await response.json()) as {
    successful?: boolean
    status?: string
  }

  if (body.successful === true || body.status === 'success') {
    return { status: 'confirmed', hash }
  }

  // Horizon knows the hash but it failed on-ledger. That is a proven failure
  // (e.g. op underfunded), not a network drop.
  return { status: 'not_found', hash }
}

declare global {
  interface Window {
    ENV: PublicEnv
  }
}
