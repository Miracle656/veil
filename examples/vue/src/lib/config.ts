import { Networks } from '@stellar/stellar-sdk'

export const appConfig = {
  factoryAddress: import.meta.env.VITE_FACTORY_ADDRESS ?? '',
  rpcUrl: import.meta.env.VITE_RPC_URL ?? 'https://soroban-testnet.stellar.org',
  horizonUrl: import.meta.env.VITE_HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
  networkPassphrase: import.meta.env.VITE_NETWORK_PASSPHRASE ?? Networks.TESTNET,
  friendbotUrl: import.meta.env.VITE_FRIENDBOT_URL ?? 'https://friendbot.stellar.org',
  explorerBaseUrl: import.meta.env.VITE_EXPLORER_BASE_URL ?? 'https://stellar.expert/explorer/testnet',
}
