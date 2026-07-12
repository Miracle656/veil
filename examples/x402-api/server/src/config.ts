import { Asset, Networks } from '@stellar/stellar-sdk'
import type { Network } from '@x402/core/types'

/**
 * Server configuration, resolved from the environment (see `.env.example`).
 *
 * The server plays two x402 roles at once so the example runs without any
 * third-party infrastructure:
 *
 *  - **Resource server** — guards `GET /paid/quote` behind a 0.01 XLM charge.
 *  - **Facilitator** — verifies the client's signed transaction and settles it
 *    on Stellar testnet, sponsoring the network fee from `FACILITATOR_SECRET`.
 */

const isMainnet = (process.env.STELLAR_NETWORK ?? 'testnet') === 'mainnet'

/** CAIP-2 network identifier used by the x402 protocol. */
export const NETWORK: Network = isMainnet ? 'stellar:pubnet' : 'stellar:testnet'

export const NETWORK_PASSPHRASE = isMainnet ? Networks.PUBLIC : Networks.TESTNET

export const RPC_URL =
  process.env.SOROBAN_RPC_URL?.trim() || 'https://soroban-testnet.stellar.org'

export const PORT = Number.parseInt(process.env.PORT ?? '4021', 10)

export const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? '*'

/**
 * Stellar secret (S…) of the account the facilitator uses to submit and
 * fee-bump the client's payment transaction. On testnet, fund it from
 * Friendbot. Required — the server refuses to start without it.
 */
export const FACILITATOR_SECRET = required('FACILITATOR_SECRET')

/**
 * Public key (G…) that receives the 0.01 XLM payment. Defaults to the
 * facilitator's own account so the example works with a single funded key.
 */
export const PAY_TO = process.env.PAY_TO?.trim() || ''

/** Native XLM represented as its Stellar Asset Contract (SAC) address. */
export const XLM_SAC_ADDRESS = Asset.native().contractId(NETWORK_PASSPHRASE)

/** 0.01 XLM expressed in stroops (XLM has 7 decimal places). */
export const PRICE_STROOPS = '100000'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    console.error(`[x402] Missing required env var: ${name} (see .env.example)`)
    process.exit(1)
  }
  return value
}
