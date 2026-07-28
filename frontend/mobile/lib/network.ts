import Constants from 'expo-constants'
import { Asset, Networks } from '@stellar/stellar-sdk'
import type { WalletConfig } from '@veil/sdk'

export type VeilNetworkName = 'testnet' | 'mainnet'

export type VeilNetwork = {
  name: VeilNetworkName
  displayName: string
  networkPassphrase: string
  horizonUrl: string
  rpcUrl: string
  factoryContractId: string
  friendbotUrl: string | null
}

const extra = Constants.expoConfig?.extra || (Constants as any).manifest?.extra || {}

function getEnvVar(key: string, altKey?: string): string | undefined {
  const val = extra[key] ?? (altKey ? extra[altKey] : undefined)
  return typeof val === 'string' ? val : undefined
}

export const NETWORKS: Record<VeilNetworkName, VeilNetwork> = {
  testnet: {
    name: 'testnet',
    displayName: 'Stellar Testnet',
    networkPassphrase: Networks.TESTNET,
    horizonUrl: getEnvVar('NEXT_PUBLIC_HORIZON_URL', 'EXPO_PUBLIC_HORIZON_URL')?.trim() || 'https://horizon-testnet.stellar.org',
    rpcUrl:
      getEnvVar('NEXT_PUBLIC_SOROBAN_RPC_URL', 'EXPO_PUBLIC_SOROBAN_RPC_URL')?.trim()
      || getEnvVar('NEXT_PUBLIC_RPC_URL', 'EXPO_PUBLIC_RPC_URL')?.trim()
      || 'https://soroban-testnet.stellar.org',
    factoryContractId:
      getEnvVar('NEXT_PUBLIC_FACTORY_CONTRACT_ID_TESTNET', 'EXPO_PUBLIC_FACTORY_CONTRACT_ID_TESTNET')?.trim()
      || getEnvVar('NEXT_PUBLIC_FACTORY_CONTRACT_ID', 'EXPO_PUBLIC_FACTORY_CONTRACT_ID')?.trim()
      || '',
    friendbotUrl: 'https://friendbot.stellar.org',
  },
  mainnet: {
    name: 'mainnet',
    displayName: 'Stellar Mainnet',
    networkPassphrase: Networks.PUBLIC,
    horizonUrl: 'https://horizon.stellar.org',
    rpcUrl: getEnvVar('NEXT_PUBLIC_MAINNET_RPC_URL', 'EXPO_PUBLIC_MAINNET_RPC_URL')?.trim() || '',
    factoryContractId: getEnvVar('NEXT_PUBLIC_FACTORY_CONTRACT_ID_MAINNET', 'EXPO_PUBLIC_FACTORY_CONTRACT_ID_MAINNET')?.trim() || '',
    friendbotUrl: null,
  },
}

export function getNetwork(): VeilNetwork {
  return getEnvVar('NEXT_PUBLIC_NETWORK', 'EXPO_PUBLIC_NETWORK') === 'mainnet'
    ? NETWORKS.mainnet
    : NETWORKS.testnet
}

export const walletConfig: WalletConfig = {
  factoryAddress: getNetwork().factoryContractId,
  rpcUrl: getNetwork().rpcUrl,
  networkPassphrase: getNetwork().networkPassphrase,
}

export function getNativeAssetContractId(): string {
  return Asset.native().contractId(getNetwork().networkPassphrase)
}

export function buildFriendbotUrl(address: string): string | null {
  const friendbotUrl = getNetwork().friendbotUrl
  if (!friendbotUrl) return null

  const url = new URL(friendbotUrl)
  url.searchParams.set('addr', address)
  return url.toString()
}
