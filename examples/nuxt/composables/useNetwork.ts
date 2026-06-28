import { Asset, Networks } from '@stellar/stellar-sdk'
import type { WalletConfig } from 'invisible-wallet-sdk/vanilla'

/**
 * Resolves the active Stellar network from Nuxt runtime config and derives the
 * {@link WalletConfig} the SDK needs. Auto-imported by Nuxt — call it from any
 * component or composable.
 */
export function useNetwork() {
  const cfg = useRuntimeConfig().public
  const isMainnet = cfg.network === 'mainnet'
  const networkPassphrase = isMainnet ? Networks.PUBLIC : Networks.TESTNET

  const walletConfig: WalletConfig = {
    factoryAddress: cfg.factoryContractId,
    rpcUrl: cfg.sorobanRpcUrl,
    networkPassphrase,
  }

  return {
    isMainnet,
    networkPassphrase,
    rpcUrl: cfg.sorobanRpcUrl,
    horizonUrl: cfg.horizonUrl,
    friendbotUrl: isMainnet ? null : 'https://friendbot.stellar.org',
    walletConfig,
    /** Contract id of the native (XLM) Stellar Asset Contract on this network. */
    nativeAssetContractId: () => Asset.native().contractId(networkPassphrase),
  }
}
