import { Asset, Networks } from '@stellar/stellar-sdk'
import type { WalletConfig } from 'invisible-wallet-sdk'

const isMainnet = process.env.NEXT_PUBLIC_NETWORK === 'mainnet'
const stellarNetwork = isMainnet ? Networks.PUBLIC : Networks.TESTNET

export const network = {
  networkPassphrase: stellarNetwork,
  rpcUrl:
    process.env.NEXT_PUBLIC_SOROBAN_RPC_URL?.trim() || 'https://soroban-testnet.stellar.org',
  horizonUrl:
    process.env.NEXT_PUBLIC_HORIZON_URL?.trim() || 'https://horizon-testnet.stellar.org',
  factoryContractId: process.env.NEXT_PUBLIC_FACTORY_CONTRACT_ID?.trim() || '',
  friendbotUrl: isMainnet ? null : 'https://friendbot.stellar.org',
}

export const walletConfig: WalletConfig = {
  factoryAddress: network.factoryContractId,
  rpcUrl: network.rpcUrl,
  networkPassphrase: network.networkPassphrase,
}

export function getNativeAssetContractId(): string {
  return Asset.native().contractId(network.networkPassphrase)
}

// ── Subscription configuration ───────────────────────────────────────────────

const STROOPS_PER_UNIT = 10_000_000

/** Token the subscription is billed in. Defaults to native XLM (the SAC). */
export function getSubscriptionToken(): string {
  return process.env.NEXT_PUBLIC_SUBSCRIPTION_TOKEN?.trim() || getNativeAssetContractId()
}

export const subscription = {
  /** The merchant (spender) the recurring authorization pays. */
  merchant: process.env.NEXT_PUBLIC_MERCHANT_ADDRESS?.trim() || '',
  /** Price per period, in whole token units (e.g. 5 XLM). */
  priceUnits: Number(process.env.NEXT_PUBLIC_SUBSCRIPTION_PRICE?.trim() || '5'),
  /** Billing period length, in days. */
  periodDays: Number(process.env.NEXT_PUBLIC_SUBSCRIPTION_PERIOD_DAYS?.trim() || '30'),
  /** Price per period, in contract base units (stroops for native XLM). */
  get priceBaseUnits(): number {
    return Math.round(this.priceUnits * STROOPS_PER_UNIT)
  },
}
