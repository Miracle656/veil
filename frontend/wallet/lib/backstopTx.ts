import {
  Account,
  Address,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc as SorobanRpc,
} from '@stellar/stellar-sdk'

import { configuredBackstopId } from './backstopConfig'
import { inclusionFee } from './fees'
import { getNetwork } from './network'

/**
 * Blend backstop write path — builds XDR only.
 *
 * The screen hands the XDR to `signAndSubmitSorobanXdr`, which is the wallet's
 * one Soroban signing path (simulate, assemble, sign, poll). Building a second
 * simulate/assemble/sign sequence in a screen is how CR-1 — signing whatever
 * auth entries the RPC hands back — would propagate into a new money path.
 *
 * The invocation is encoded with the Stellar SDK's own `Contract` client so
 * this module needs no Blend SDK import: the Blend SDK pins a second
 * `@stellar/stellar-sdk` whose ESM-only dependencies the wallet's Jest runtime
 * cannot load, and a transaction builder that cannot be exercised by a test is
 * a transaction builder nobody has checked.
 *
 * Units: `deposit` takes **BLND:USDC LP tokens**; `queue_withdrawal`,
 * `dequeue_withdrawal` and `withdraw` take **shares**. They are never
 * interchangeable.
 */

/** The contract's method names, which differ from the screen's wording. */
const METHOD_NAMES = {
  deposit: 'deposit',
  queueWithdrawal: 'queue_withdrawal',
  dequeueWithdrawal: 'dequeue_withdrawal',
  withdraw: 'withdraw',
} as const

export type BackstopMethod = keyof typeof METHOD_NAMES

export interface BackstopActionParams {
  backstopId?: string
  poolId: string
  /** The G… account the transaction is built for and signs with. */
  sourceAddress: string
  /** The address whose deposit is moved. Same account in this wallet. */
  from: string
  /** LP tokens for `deposit`, shares for every other method. */
  amountStroops: bigint
}

export function requireAddress(value: string, label: string): string {
  const address = value.trim()
  try {
    Address.fromString(address)
  } catch {
    throw new Error(`${label} is not a valid Stellar address.`)
  }
  return address
}

export async function buildBackstopActionXdr(
  method: BackstopMethod,
  params: BackstopActionParams,
): Promise<string> {
  const net = getNetwork()
  const backstopId = requireAddress(params.backstopId ?? configuredBackstopId(), 'Backstop')
  const poolId = requireAddress(params.poolId, 'Pool')
  const from = requireAddress(params.from, 'Wallet')
  const source = requireAddress(params.sourceAddress, 'Source account')
  if (params.amountStroops <= 0n) {
    throw new Error('Amount must be greater than zero.')
  }

  const rpc = new SorobanRpc.Server(net.rpcUrl)
  const sourceAccount = await rpc.getAccount(source)

  const operation = new Contract(backstopId).call(
    METHOD_NAMES[method],
    new Address(from).toScVal(),
    new Address(poolId).toScVal(),
    nativeToScVal(params.amountStroops, { type: 'i128' }),
  )

  const transaction = new TransactionBuilder(
    new Account(sourceAccount.accountId(), sourceAccount.sequenceNumber()),
    { fee: inclusionFee(), networkPassphrase: net.networkPassphrase },
  )
    .addOperation(operation)
    .setTimeout(30)
    .build()

  const simulation = await rpc.simulateTransaction(transaction)
  if (SorobanRpc.Api.isSimulationError(simulation)) {
    throw new Error(`Backstop ${method} simulation failed: ${simulation.error}`)
  }

  return SorobanRpc.assembleTransaction(transaction, simulation).build().toXDR()
}

/** Deposit BLND:USDC LP tokens into a pool's backstop. `amount` is LP tokens. */
export function buildBackstopDepositXdr(params: BackstopActionParams): Promise<string> {
  return buildBackstopActionXdr('deposit', params)
}

/** Start the withdrawal queue. `amount` is shares. */
export function buildBackstopQueueWithdrawalXdr(params: BackstopActionParams): Promise<string> {
  return buildBackstopActionXdr('queueWithdrawal', params)
}

/**
 * Cancel a queued withdrawal and return those shares to the depositing
 * position. The contract's method is `dequeue_withdrawal`; the SDK and the
 * screens call it "cancel" because that is what it does to the user's queue.
 * `amount` is shares, limited by what is queued — not by the un-queued balance.
 */
export function buildBackstopCancelWithdrawalXdr(params: BackstopActionParams): Promise<string> {
  return buildBackstopActionXdr('dequeueWithdrawal', params)
}

/** Release queued shares once their lock has expired. `amount` is shares. */
export function buildBackstopWithdrawXdr(params: BackstopActionParams): Promise<string> {
  return buildBackstopActionXdr('withdraw', params)
}
