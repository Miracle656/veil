import {
  Keypair,
  Account,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  rpc as SorobanRpc,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'
import { network, subscription, getSubscriptionToken } from './network'

export type Allowance = { amount: number; expiry: number | undefined }

export type SubscriptionStatus = {
  active: boolean
  /** Unix seconds the authorization expires, or null when none / perpetual. */
  expiresAt: number | null
  /** Remaining authorized amount in base units, or 0 when none. */
  remaining: number
}

/**
 * Read a wallet contract's allowance for (spender, token) straight from chain via
 * a read-only Soroban simulation. No signing is involved, so this runs on the
 * server (middleware / route handlers) and the client alike. Returns null when no
 * allowance is set. Mirrors `useInvisibleWallet().getAllowance`.
 */
export async function readAllowance(
  walletAddress: string,
  spender: string,
  token: string,
): Promise<Allowance | null> {
  const server = new SorobanRpc.Server(network.rpcUrl)
  const walletContract = new Contract(walletAddress)

  // Dummy source account — we only simulate, never submit.
  const dummy = new Account(Keypair.random().publicKey(), '0')
  const tx = new TransactionBuilder(dummy, {
    fee: BASE_FEE,
    networkPassphrase: network.networkPassphrase,
  })
    .addOperation(
      walletContract.call(
        'get_allowance',
        nativeToScVal(spender, { type: 'address' }),
        nativeToScVal(token, { type: 'address' }),
      ),
    )
    .setTimeout(30)
    .build()

  const sim = await server.simulateTransaction(tx)
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Allowance simulation failed: ${sim.error}`)
  }

  const result = (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result
  if (!result || !result.retval) return null
  if (result.retval.switch() === xdr.ScValType.scvVoid()) return null

  const map = scValToNative(result.retval) as { amount: unknown; expiry?: unknown }
  return {
    amount: Number(map.amount),
    expiry: map.expiry !== undefined ? Number(map.expiry) : undefined,
  }
}

/**
 * Resolve a wallet's subscription status by reading its on-chain allowance to the
 * configured merchant. The subscription is "active" while the wallet holds a
 * positive, unexpired authorization to the merchant — i.e. the recurring payment
 * the merchant can pull from.
 */
export async function getSubscriptionStatus(
  walletAddress: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<SubscriptionStatus> {
  if (!walletAddress || !subscription.merchant) {
    return { active: false, expiresAt: null, remaining: 0 }
  }

  const allowance = await readAllowance(
    walletAddress,
    subscription.merchant,
    getSubscriptionToken(),
  )
  if (!allowance || allowance.amount <= 0) {
    return {
      active: false,
      expiresAt: allowance?.expiry ?? null,
      remaining: allowance?.amount ?? 0,
    }
  }

  const expiresAt = allowance.expiry ?? null
  const notExpired = expiresAt === null || expiresAt > nowSeconds
  return { active: notExpired, expiresAt, remaining: allowance.amount }
}
