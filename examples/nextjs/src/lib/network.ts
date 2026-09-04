import { Asset, Networks } from '@stellar/stellar-sdk'
import type { WalletConfig } from 'invisible-wallet-sdk'

const isMainnet = process.env.NEXT_PUBLIC_NETWORK === 'mainnet'

export const network = {
  networkPassphrase: isMainnet ? Networks.PUBLIC : Networks.TESTNET,
  rpcUrl:
    process.env.NEXT_PUBLIC_SOROBAN_RPC_URL?.trim() ||
    'https://soroban-testnet.stellar.org',
  horizonUrl:
    process.env.NEXT_PUBLIC_HORIZON_URL?.trim() ||
    'https://horizon-testnet.stellar.org',
  factoryContractId:
    process.env.NEXT_PUBLIC_FACTORY_CONTRACT_ID?.trim() || '',
  friendbotUrl: isMainnet ? null : 'https://friendbot.stellar.org',
}

export const walletConfig: WalletConfig = {
  factoryAddress: network.factoryContractId,
  rpcUrl: network.rpcUrl,
  networkPassphrase: network.networkPassphrase,
  // Allow the relying-party id and origin to be explicitly configured via
  // environment variables (NEXT_PUBLIC_RP_ID / NEXT_PUBLIC_ORIGIN). This is
  // necessary for native builds where window.location is not available.
  rpId: process.env.NEXT_PUBLIC_RP_ID?.trim() || undefined,
  origin: process.env.NEXT_PUBLIC_ORIGIN?.trim() || undefined,
}

export function getNativeAssetContractId(): string {
  return Asset.native().contractId(network.networkPassphrase)
}
