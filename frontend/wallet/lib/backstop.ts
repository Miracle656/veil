import { inclusionFee } from './fees'
import {
  Account,
  rpc as SorobanRpc,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import { getNetwork } from '@/lib/network'
import {
  BackstopContractV1,
  BackstopContractV2,
  Backstop,
  BackstopPoolUser,
  type Network,
  type Q4W,
} from '@blend-capital/blend-sdk'

const net = getNetwork()

const blendNetwork: Network = {
  rpc: net.rpcUrl,
  passphrase: net.networkPassphrase,
}

/**
 * 17 days in seconds: the mandatory cooldown for the Blend Backstop unbonding queue.
 * 17 days * 24 hours * 3600 seconds = 1,468,800 seconds (~293,760 ledgers at 5s/ledger).
 */
export const BACKSTOP_UNBONDING_SECONDS = 17 * 24 * 60 * 60

/**
 * Known Backstop contract addresses on Stellar.
 * Mainnet: CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7
 */
export const DEFAULT_BACKSTOP_IDS: Record<'mainnet' | 'testnet', string> = {
  mainnet: 'CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7',
  testnet: '',
}

export interface BackstopQueueEntry {
  amount: bigint
  /** Expiration timestamp in seconds when withdrawal matures and can be claimed. */
  exp: bigint
}

export interface BackstopUserBalance {
  userAddress: string
  poolId: string
  shares: bigint
  queuedWithdrawals: BackstopQueueEntry[]
  totalQueued: bigint
  unlockedQueued: bigint
  lockedQueued: bigint
}

export interface BackstopPoolData {
  backstopId: string
  poolId: string
  backstopTokenId: string
  blndPerLpToken: number
  usdcPerLpToken: number
  lpTokenPrice: number
  shares: bigint
  emissionsPerYear?: bigint
  takeRate?: number
}

export interface BackstopActionParams {
  backstopId: string
  poolId: string
  fromAddress: string
  sourceAddress: string
  amount: bigint
}

export interface BackstopRiskDisclosure {
  layer1: {
    title: string
    risks: string[]
  }
  layer2: {
    title: string
    risks: string[]
  }
  warning: string
}

/**
 * Explicit two-layer risk disclosure for Blend Backstop restaking positions.
 * MUST be displayed to users before any restaking deposit.
 */
export function getBackstopRiskDisclosure(): BackstopRiskDisclosure {
  return {
    layer1: {
      title: 'Layer 1: Underlying Liquidity Pool Exposure (BLND:USDC LP)',
      risks: [
        'Market & Price Risk: Exposure to price movements of BLND and USDC. If BLND loses value, your LP value drops.',
        'Impermanent Loss: Volatility and price ratio changes between BLND and USDC reduce returns relative to holding assets separately.',
        'AMM Smart Contract Risk: Security and solvency of the underlying AMM liquidity pool.',
      ],
    },
    layer2: {
      title: 'Layer 2: Backstop Staking & First-Loss Underwriting',
      risks: [
        'Junior Tranche First-Loss Capital: Backstop depositors hold the absolute most junior claim in the protocol. Your capital directly absorbs bad debt from borrower defaults before senior pool depositors.',
        '17-Day Illiquidity Queue: Withdrawals require a mandatory 17-day cooldown (1,468,800 seconds). You cannot emergency-exit during market crashes.',
        'Slashable During Queue: Queued funds REMAIN at risk of absorbing bad debt during the entire 17-day period until withdrawn.',
        'Borrower Default Contagion: Systemic liquidations in the lending pool can deplete the backstop.',
      ],
    },
    warning:
      'Restaking stacks risk as well as yield. A user in the backstop is holding the most junior claim in the protocol: their shares are what absorbs bad debt, and the 17-day queue exists precisely so they cannot leave before that happens. Whatever this becomes, it is not a savings account, and it must never be presented beside one as though it were a slightly better rate.',
  }
}

/** Load Backstop contract and pool metadata. */
export async function loadBackstop(backstopId: string): Promise<BackstopPoolData | null> {
  try {
    const backstop = await Backstop.load(blendNetwork, backstopId)
    const token = backstop.backstopToken

    return {
      backstopId,
      poolId: '',
      backstopTokenId: token?.id || '',
      blndPerLpToken: token?.blndPerLpToken || 0,
      usdcPerLpToken: token?.usdcPerLpToken || 0,
      lpTokenPrice: token?.lpTokenPrice || 0,
      shares: token?.shares || 0n,
    }
  } catch (err) {
    console.warn(`[backstop] failed loading backstop ${backstopId}:`, err)
    return null
  }
}

/** Load user backstop balance and withdrawal queue for a specific lending pool. */
export async function loadBackstopUserBalance(
  backstopId: string,
  poolId: string,
  userAddress: string
): Promise<BackstopUserBalance | null> {
  try {
    const poolUser = await BackstopPoolUser.load(blendNetwork, backstopId, poolId, userAddress)

    const queued: BackstopQueueEntry[] = (poolUser.balance?.q4w || []).map((q: Q4W) => ({
      amount: BigInt(q.amount.toString()),
      exp: BigInt(q.exp.toString()),
    }))

    const total = BigInt(poolUser.balance?.totalQ4W?.toString() || '0')
    const unlocked = BigInt(poolUser.balance?.unlockedQ4W?.toString() || '0')
    const locked = total >= unlocked ? total - unlocked : 0n

    return {
      userAddress,
      poolId,
      shares: BigInt(poolUser.balance?.shares?.toString() || '0'),
      queuedWithdrawals: queued,
      totalQueued: total,
      unlockedQueued: unlocked,
      lockedQueued: locked,
    }
  } catch (err) {
    console.warn(`[backstop] failed loading user balance for ${userAddress}:`, err)
    return null
  }
}

/**
 * Build a Backstop deposit transaction XDR.
 * Deposits LP tokens into the Backstop module to underwrite a lending pool.
 */
export async function buildBackstopDepositXdr(params: BackstopActionParams): Promise<string | null> {
  return buildBackstopActionXdr(params, 'deposit')
}

/**
 * Build a Backstop queue-withdrawal transaction XDR.
 * Moves active backstop shares into the 17-day unbonding cooldown queue.
 */
export async function buildBackstopQueueWithdrawalXdr(
  params: BackstopActionParams
): Promise<string | null> {
  return buildBackstopActionXdr(params, 'queueWithdrawal')
}

/**
 * Build a Backstop dequeue-withdrawal transaction XDR.
 * Cancels a queued withdrawal before it is executed, restoring active shares.
 */
export async function buildBackstopDequeueWithdrawalXdr(
  params: BackstopActionParams
): Promise<string | null> {
  return buildBackstopActionXdr(params, 'dequeueWithdrawal')
}

/**
 * Build a Backstop withdrawal transaction XDR.
 * Completes withdrawal after the 17-day cooldown expires, returning LP tokens.
 */
export async function buildBackstopWithdrawXdr(
  params: BackstopActionParams
): Promise<string | null> {
  return buildBackstopActionXdr(params, 'withdraw')
}

type BackstopActionType = 'deposit' | 'queueWithdrawal' | 'dequeueWithdrawal' | 'withdraw'

async function buildBackstopActionXdr(
  params: BackstopActionParams,
  action: BackstopActionType
): Promise<string | null> {
  try {
    const rpc = new SorobanRpc.Server(net.rpcUrl)
    const sourceAccount = await rpc.getAccount(params.sourceAddress)

    const contractArgs = {
      from: params.fromAddress,
      pool_address: params.poolId,
      amount: params.amount,
    }

    let opXdr: string
    try {
      const contract = new BackstopContractV2(params.backstopId)
      opXdr = contract[action](contractArgs)
    } catch {
      const contract = new BackstopContractV1(params.backstopId)
      opXdr = contract[action](contractArgs)
    }

    const operation = xdr.Operation.fromXDR(opXdr, 'base64')

    const tx = new TransactionBuilder(
      new Account(sourceAccount.accountId(), sourceAccount.sequenceNumber()),
      {
        fee: inclusionFee(),
        networkPassphrase: net.networkPassphrase,
      }
    )
      .addOperation(operation)
      .setTimeout(30)
      .build()

    const sim = await rpc.simulateTransaction(tx)
    if (SorobanRpc.Api.isSimulationError(sim)) {
      throw new Error(`Simulation failed: ${sim.error}`)
    }

    return SorobanRpc.assembleTransaction(tx, sim).build().toXDR()
  } catch (err) {
    console.warn(`[backstop] build ${action} XDR failed:`, err)
    return null
  }
}
