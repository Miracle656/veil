import {
  Account,
  Address,
  Contract,
  Horizon,
  TransactionBuilder,
  rpc as SorobanRpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'
import {
  Backstop,
  BackstopConfig,
  BackstopContractV2,
  BackstopPoolUser,
  BackstopPoolUserEst,
  BackstopPoolV2,
  type Network,
} from '@blend-capital/blend-sdk'

import { FALLBACK_QUEUE_LOCK_SECONDS, stroopsToShares } from './backstopAmounts'
import { configuredBackstopId } from './backstopConfig'
import { requireAddress } from './backstopTx'
import { inclusionFee } from './fees'
import { configuredPoolIds } from './blend'
import { getNetwork } from './network'

export { configuredBackstopId } from './backstopConfig'
// Amount and date formatting lives in its own SDK-free module so the screen and
// its test use the implementation that ships rather than a copy of it.
export {
  FALLBACK_QUEUE_LOCK_SECONDS,
  formatLockDuration,
  formatUnlockDate,
  sharesToStroops,
  stroopsToShares,
} from './backstopAmounts'
export {
  buildBackstopCancelWithdrawalXdr,
  buildBackstopDepositXdr,
  buildBackstopQueueWithdrawalXdr,
  buildBackstopWithdrawXdr,
  type BackstopActionParams,
} from './backstopTx'

/**
 * Blend backstop: the first-loss deposit a user makes into a lending pool.
 *
 * Read side loads from the ledger through the Blend SDK, which is how the
 * figures are derived for the mobile client too — `tokens`, `totalSpotValue`
 * and `emissions` come from the same `BackstopPoolUserEst.build` call, so the
 * two clients cannot drift on the arithmetic.
 *
 * Units are not interchangeable and this module keeps them apart:
 *
 *   - `deposit` takes **BLND:USDC LP tokens** (the backstop token amount);
 *   - `queue_withdrawal`, `dequeue_withdrawal` and `withdraw` take **shares**.
 *
 * `BackstopPoolUserEst` reports the queue in LP-token terms (`totalQ4W`,
 * `totalUnlockedQ4W`), which is why a screen that reads those numbers and then
 * hands the typed amount to `queue_withdrawal` is sending the wrong unit. The
 * position below is built from the raw `UserBalance` instead, so every queued
 * figure is shares.
 *
 * Write side **builds XDR only**, the same split `lib/blend.ts` uses. The
 * screen hands the XDR to `signAndSubmitSorobanXdr`, which is the wallet's one
 * Soroban signing path (simulate, assemble, sign, poll). Building a second
 * simulate/assemble/sign sequence here is how CR-1 — signing whatever auth
 * entries the RPC hands back — would propagate into a new money path.
 */

/** Stellar base reserve per ledger entry, in XLM. */
const BASE_RESERVE_XLM = 0.5

export interface BackstopQueuedWithdrawal {
  /** Shares in this queue entry — the unit queue/cancel/withdraw take. */
  shares: bigint
  /** Unix seconds when these shares come out of the lock. */
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
  /** Each queue entry, in shares, with the time its lock expires. */
  queued: BackstopQueuedWithdrawal[]
  /** Shares across every queue entry — the limit for a cancel. */
  queuedShares: bigint
  /** Queued shares whose lock has expired — the limit for a withdraw. */
  unlockedShares: bigint
}

export interface BackstopPositionsResult {
  positions: BackstopPosition[]
  /**
   * Pools whose position could not be loaded. A failed read is not an empty
   * position: the screen has to say "we could not check" rather than "you have
   * nothing at risk".
   */
  failedPoolIds: string[]
}

function blendNetwork(): Network {
  const net = getNetwork()
  return { rpc: net.rpcUrl, passphrase: net.networkPassphrase }
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

  // The queue is read from the raw balance, not from `est`: the estimate
  // reports queued amounts in LP tokens while the contract's queue methods take
  // shares, and mixing the two is exactly the units bug this screen had.
  const now = Math.floor(Date.now() / 1_000)
  const queued: BackstopQueuedWithdrawal[] = user.balance.q4w.map((entry) => ({
    shares: entry.amount,
    exp: Number(entry.exp),
  }))
  let queuedShares = 0n
  let unlockedShares = 0n
  for (const entry of queued) {
    queuedShares += entry.shares
    if (entry.exp <= now) unlockedShares += entry.shares
  }

  return {
    backstopId,
    poolId,
    userId,
    shares: user.balance.shares,
    shareValue: est.totalSpotValue,
    blnd: est.blnd,
    usdc: est.usdc,
    emissions: est.emissions,
    queued,
    queuedShares,
    unlockedShares,
  }
}

/** Load the position for every configured pool, skipping pools not backstopped. */
export async function loadBackstopPositions(
  userId: string,
  poolIds: string[] = configuredPoolIds(),
): Promise<BackstopPositionsResult> {
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
  return {
    positions: loaded.filter((position): position is BackstopPosition => position !== null),
    failedPoolIds: poolIds.filter((_, index) => loaded[index] === null),
  }
}

/** Simulate a single read-only contract invocation and return its `retval`. */
async function simulateRead(params: {
  sourceAddress: string
  operation: xdr.Operation
}): Promise<xdr.ScVal> {
  const net = getNetwork()
  const rpc = new SorobanRpc.Server(net.rpcUrl)
  const source = await rpc.getAccount(params.sourceAddress)
  const transaction = new TransactionBuilder(
    new Account(source.accountId(), source.sequenceNumber()),
    { fee: inclusionFee(), networkPassphrase: net.networkPassphrase },
  )
    .addOperation(params.operation)
    .setTimeout(30)
    .build()

  const simulation = await rpc.simulateTransaction(transaction)
  if (SorobanRpc.Api.isSimulationError(simulation)) {
    throw new Error(`Contract read failed: ${simulation.error}`)
  }
  const result = (simulation as SorobanRpc.Api.SimulateTransactionSuccessResponse).result
  if (!result?.retval) throw new Error('Contract read returned no value.')
  return result.retval
}

/** The BLND:USDC backstop token the contract holds, as its contract id. */
export async function backstopTokenId(backstopId?: string): Promise<string> {
  const id = requireAddress(backstopId ?? configuredBackstopId(), 'Backstop')
  const config = await BackstopConfig.load(blendNetwork(), id)
  return config.backstopTkn
}

/** A Soroban token's balance for `owner`, in stroops. */
export async function readTokenBalance(params: {
  tokenId: string
  owner: string
}): Promise<bigint> {
  const tokenId = requireAddress(params.tokenId, 'Token')
  const owner = requireAddress(params.owner, 'Wallet')
  const retval = await simulateRead({
    sourceAddress: owner,
    operation: new Contract(tokenId).call('balance', new Address(owner).toScVal()),
  })
  const value = scValToNative(retval)
  return typeof value === 'bigint' ? value : BigInt(value)
}

const lockSecondsCache = new Map<string, number>()

/**
 * The queue lock length, in seconds, read from the deployed backstop.
 *
 * The contract has no getter for `Q4W_LOCK_TIME`, so the authoritative source
 * is the expiry it stamps on a new queue entry: `queue_withdrawal(…, 0)` is
 * simulated (never submitted) and the returned `Q4W.exp` minus now is the lock.
 * Zero shares queue cleanly — the contract admits any amount up to the balance
 * and appends an entry with `now + Q4W_LOCK_TIME`.
 *
 * Falls back to {@link FALLBACK_QUEUE_LOCK_SECONDS} only when that read cannot
 * be made (RPC down, queue already at `MAX_Q4W_SIZE`, a non-Blend pool). An
 * operator override is honoured first, per network build.
 */
export async function loadBackstopQueueLockSeconds(params: {
  backstopId?: string
  poolId: string
  sourceAddress: string
}): Promise<number> {
  const backstopId = requireAddress(params.backstopId ?? configuredBackstopId(), 'Backstop')
  const cached = lockSecondsCache.get(backstopId)
  if (cached) return cached

  const configured = Number(process.env.NEXT_PUBLIC_BLEND_BACKSTOP_Q4W_LOCK_SECONDS)
  if (Number.isFinite(configured) && configured > 0) {
    lockSecondsCache.set(backstopId, configured)
    return configured
  }

  try {
    const client = new BackstopContractV2(backstopId)
    const operation = xdr.Operation.fromXDR(
      client.queueWithdrawal({
        from: requireAddress(params.sourceAddress, 'Wallet'),
        pool_address: requireAddress(params.poolId, 'Pool'),
        amount: 0n,
      }),
      'base64',
    )
    const retval = await simulateRead({
      sourceAddress: params.sourceAddress,
      operation,
    })
    const entry = scValToNative(retval) as { exp?: number | bigint } | null
    const exp = Number(entry?.exp)
    // The simulated entry expires one lock from the ledger's own clock, so the
    // difference is the lock; rounded to the minute to absorb clock skew.
    const seconds = Math.round((exp - Date.now() / 1_000) / 60) * 60
    if (Number.isFinite(seconds) && seconds >= 60 && seconds <= 90 * 86_400) {
      lockSecondsCache.set(backstopId, seconds)
      return seconds
    }
  } catch (err) {
    console.warn('[backstop] could not read the queue lock from the contract:', err)
  }

  return FALLBACK_QUEUE_LOCK_SECONDS
}

/**
 * What the review step found before the passkey prompt, so a transaction that
 * cannot pay its fee or cannot be backed by the tokens is never signed.
 */
export interface BackstopPreflight {
  ok: boolean
  /** Human-readable reasons signing is blocked, empty when `ok`. */
  problems: string[]
  /** XLM the account holds. */
  xlmBalance: number
  /** XLM the account must keep for its reserve plus this transaction's fee. */
  requiredXlm: number
  /** BLND:USDC LP tokens held, formatted. `null` when it could not be read. */
  lpBalance: string | null
}

/**
 * Check the cheap, common failures before asking for a signature: an account
 * that cannot cover the network fee, and a deposit it does not hold the LP
 * tokens for.
 */
export async function runBackstopPreflight(params: {
  backstopId?: string
  method: 'deposit' | 'queueWithdrawal' | 'dequeueWithdrawal' | 'withdraw'
  sourceAddress: string
  amountStroops: bigint
}): Promise<BackstopPreflight> {
  const net = getNetwork()
  const source = requireAddress(params.sourceAddress, 'Wallet')
  const feeXlm = Number(inclusionFee()) / 10_000_000
  const problems: string[] = []

  let xlmBalance = 0
  let requiredXlm = feeXlm
  try {
    const account = await new Horizon.Server(net.horizonUrl).loadAccount(source)
    const native = account.balances.find((balance) => balance.asset_type === 'native')
    xlmBalance = Number(native?.balance ?? 0)
    const reserveUnits =
      2 +
      (account.subentry_count ?? 0) +
      (account.num_sponsoring ?? 0) -
      (account.num_sponsored ?? 0)
    requiredXlm = Math.max(0, reserveUnits) * BASE_RESERVE_XLM + feeXlm
    if (xlmBalance < requiredXlm) {
      problems.push(
        `You need about ${requiredXlm.toFixed(2)} XLM to keep your reserve and pay the network fee, and you hold ${xlmBalance.toFixed(2)} XLM. Add XLM before signing.`,
      )
    }
  } catch {
    problems.push(
      'Could not read your XLM balance, so the network fee cannot be checked. Try again in a moment.',
    )
  }

  let lpBalance: string | null = null
  if (params.method === 'deposit') {
    try {
      const tokenId = await backstopTokenId(params.backstopId)
      const held = await readTokenBalance({ tokenId, owner: source })
      lpBalance = stroopsToShares(held)
      if (held < params.amountStroops) {
        problems.push(
          `This deposit needs ${stroopsToShares(params.amountStroops)} BLND:USDC LP tokens and you hold ${lpBalance}.`,
        )
      }
    } catch {
      problems.push(
        'Could not read your BLND:USDC LP token balance, so this deposit cannot be checked. Try again in a moment.',
      )
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    xlmBalance,
    requiredXlm,
    lpBalance,
  }
}

