import {
  Account,
  Address,
  TransactionBuilder,
  rpc as SorobanRpc,
  xdr,
} from '@stellar/stellar-sdk'
import {
  Backstop,
  BackstopContractV2,
  BackstopPoolUser,
  BackstopPoolUserEst,
  BackstopPoolV2,
  type Network,
} from '@blend-capital/blend-sdk'

import { inclusionFee } from './fees'
import { configuredPoolIds } from './blend'
import { getNetwork } from './network'

/**
 * Blend backstop: the first-loss deposit a user makes into a lending pool.
 *
 * Read side loads from the ledger through the Blend SDK, which is how the
 * figures are derived for the mobile client too — `tokens`, `totalSpotValue`
 * and `emissions` come from the same `BackstopPoolUserEst.build` call, so the
 * two clients cannot drift on the arithmetic.
 *
 * Write side **builds XDR only**, the same split `lib/blend.ts` uses. The
 * screen hands the XDR to `signAndSubmitSorobanXdr`, which is the wallet's one
 * Soroban signing path (simulate, assemble, sign, poll). Building a second
 * simulate/assemble/sign sequence here is how CR-1 — signing whatever auth
 * entries the RPC hands back — would propagate into a new money path.
 */

const STROOPS_PER_SHARE = 10_000_000n

/**
 * Backstop contract per network. Mainnet has been deployed since v2; testnet
 * has no Blend deployment (the same reason `lib/blend.ts` leaves its testnet
 * pool id empty), so the value is only ever what an operator configures.
 */
const DEFAULT_BACKSTOP_IDS: Record<'mainnet' | 'testnet', string> = {
  mainnet: 'CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7',
  testnet: '',
}

export function configuredBackstopId(): string {
  const name = getNetwork().name
  // Next.js inlines NEXT_PUBLIC_* only when referenced literally.
  const perNetwork =
    name === 'mainnet'
      ? process.env.NEXT_PUBLIC_BLEND_BACKSTOP_ID_MAINNET
      : process.env.NEXT_PUBLIC_BLEND_BACKSTOP_ID_TESTNET

  return (
    perNetwork?.trim() ||
    process.env.NEXT_PUBLIC_BLEND_BACKSTOP_ID?.trim() ||
    DEFAULT_BACKSTOP_IDS[name === 'mainnet' ? 'mainnet' : 'testnet']
  )
}

export interface BackstopQueuedWithdrawal {
  /** LP tokens this queued entry will release, in whole tokens. */
  amount: number
  /** Unix seconds when this entry can be withdrawn. */
  exp: number
}

export interface BackstopPosition {
  backstopId: string
  poolId: string
  userId: string
  /** Shares still deposited, as the raw i128 the contract stores. */
  shares: bigint
  /** Current value of those shares in LP tokens — not the amount deposited. */
  shareValue: number
  /** The same value split into its BLND and USDC legs. */
  blnd: number
  usdc: number
  /** Emissions accrued, in BLND. Reported apart from the position value. */
  emissions: number
  queued: BackstopQueuedWithdrawal[]
  /** LP tokens currently queued, across every entry. */
  totalQueued: number
  /** Queued LP tokens whose 17-day lock has expired and can be withdrawn. */
  unlockedQueued: number
  /** Raw shares withdrawable right now, for a "withdraw all" amount. */
  unlockedShares: bigint
}

function blendNetwork(): Network {
  const net = getNetwork()
  return { rpc: net.rpcUrl, passphrase: net.networkPassphrase }
}

/** LP shares carry the same 7 decimals as every other Stellar amount. */
export function sharesToStroops(value: string): bigint {
  const amount = value.trim()
  if (!/^\d+(?:\.\d{0,7})?$/.test(amount)) {
    throw new Error('Enter a valid amount with no more than 7 decimal places.')
  }
  const [whole, fraction = ''] = amount.split('.')
  const stroops = BigInt(whole) * STROOPS_PER_SHARE + BigInt(fraction.padEnd(7, '0'))
  if (stroops <= 0n) {
    throw new Error('Amount must be greater than zero.')
  }
  return stroops
}

export function stroopsToShares(stroops: bigint): string {
  const negative = stroops < 0n
  const absolute = negative ? -stroops : stroops
  const whole = absolute / STROOPS_PER_SHARE
  const fraction = (absolute % STROOPS_PER_SHARE)
    .toString()
    .padStart(7, '0')
    .replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

function requireAddress(value: string, label: string): string {
  const address = value.trim()
  try {
    Address.fromString(address)
  } catch {
    throw new Error(`${label} is not a valid Stellar address.`)
  }
  return address
}

/**
 * Load one pool's backstop position for a user.
 *
 * `emissions` is whatever BLND the backstop has accrued to the deposit since
 * the last claim. It is deliberately a separate field rather than folded into
 * `shareValue`: the deposit is first-loss capital whose value can fall, while
 * emissions are a reward that has already been earned.
 */
export async function loadBackstopPosition(params: {
  backstopId?: string
  poolId: string
  userId: string
}): Promise<BackstopPosition> {
  const backstopId = requireAddress(params.backstopId ?? configuredBackstopId(), 'Backstop')
  const poolId = requireAddress(params.poolId, 'Pool')
  const userId = requireAddress(params.userId, 'Wallet')
  const net = blendNetwork()

  const [backstop, pool] = await Promise.all([
    Backstop.load(net, backstopId),
    BackstopPoolV2.load(net, backstopId, poolId),
  ])
  const user = await BackstopPoolUser.load(net, backstopId, poolId, userId)
  const est = BackstopPoolUserEst.build(backstop, pool, user)

  return {
    backstopId,
    poolId,
    userId,
    shares: user.balance.shares,
    shareValue: est.totalSpotValue,
    blnd: est.blnd,
    usdc: est.usdc,
    emissions: est.emissions,
    queued: est.q4w.map((entry) => ({ amount: entry.amount, exp: entry.exp })),
    totalQueued: est.totalQ4W,
    unlockedQueued: est.totalUnlockedQ4W,
    unlockedShares: user.balance.unlockedQ4W,
  }
}

/** Load the position for every configured pool, skipping pools not backstopped. */
export async function loadBackstopPositions(
  userId: string,
  poolIds: string[] = configuredPoolIds(),
): Promise<BackstopPosition[]> {
  const loaded = await Promise.all(
    poolIds.map(async (poolId): Promise<BackstopPosition | null> => {
      try {
        return await loadBackstopPosition({ poolId, userId })
      } catch (err) {
        console.warn(`[backstop] failed loading position for pool ${poolId}:`, err)
        return null
      }
    }),
  )
  return loaded.filter((position): position is BackstopPosition => position !== null)
}

interface BackstopActionParams {
  backstopId?: string
  poolId: string
  /** The G… account the transaction is built for and signs with. */
  sourceAddress: string
  /** The address whose deposit is moved. Same account in this wallet. */
  from: string
  amountStroops: bigint
}

async function buildBackstopActionXdr(
  method: 'deposit' | 'queueWithdrawal' | 'dequeueWithdrawal' | 'withdraw',
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
  const client = new BackstopContractV2(backstopId)
  const args = { from, pool_address: poolId, amount: params.amountStroops }

  const operation = xdr.Operation.fromXDR(
    method === 'deposit'
      ? client.deposit(args)
      : method === 'queueWithdrawal'
        ? client.queueWithdrawal(args)
        : method === 'dequeueWithdrawal'
          ? client.dequeueWithdrawal(args)
          : client.withdraw(args),
    'base64',
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

/** Start the 17-day withdrawal queue. `amount` is shares. */
export function buildBackstopQueueWithdrawalXdr(params: BackstopActionParams): Promise<string> {
  return buildBackstopActionXdr('queueWithdrawal', params)
}

/**
 * Cancel a queued withdrawal and return those shares to the depositing
 * position. The contract's method is `dequeue_withdrawal`; the SDK and the
 * screens call it "cancel" because that is what it does to the user's queue.
 */
export function buildBackstopCancelWithdrawalXdr(params: BackstopActionParams): Promise<string> {
  return buildBackstopActionXdr('dequeueWithdrawal', params)
}

/** Release queued shares once their lock has expired. `amount` is shares. */
export function buildBackstopWithdrawXdr(params: BackstopActionParams): Promise<string> {
  return buildBackstopActionXdr('withdraw', params)
}
