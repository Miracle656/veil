import type { Network } from '@x402/core/types'

const isMainnet = process.env.NEXT_PUBLIC_NETWORK === 'mainnet'

/** CAIP-2 identifier the x402 Stellar scheme expects. */
export const X402_NETWORK: Network = isMainnet ? 'stellar:pubnet' : 'stellar:testnet'

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL?.trim() || 'http://localhost:4021'

export const FRIENDBOT_URL = isMainnet ? null : 'https://friendbot.stellar.org'

/** localStorage keys, shared with the other Veil example apps. */
export const STORAGE = {
  keyId: 'invisible_wallet_key_id',
  feePayerSecret: 'veil_fee_payer_secret',
} as const
