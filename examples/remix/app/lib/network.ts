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

declare global {
  interface Window {
    ENV: PublicEnv
  }
}
