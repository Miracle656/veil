import {
  Account,
  Asset,
  Contract,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc as SorobanRpc,
} from '@stellar/stellar-sdk'

import { inclusionFee } from '../fees'
import { getNativeAssetContractId, getNetwork } from '../network'
import { walletLocal } from '../walletStorage'

/**
 * Storage key for queued stealth sweeps awaiting decorrelated transfer.
 * Stored in walletLocal so it is namespaced per network (testnet vs mainnet).
 */
export const STEALTH_PENDING_SWEEPS_STORAGE_KEY = 'veil_stealth_pending_sweeps'

/**
 * Default delay window boundaries for decorrelating incoming stealth payments
 * from on-chain wallet sweep transactions.
 * Default: 15 minutes (900 seconds) to 45 minutes (2700 seconds).
 * On Stellar (5-second block time), this spans 180 to 540 ledger closes.
 */
export const DEFAULT_MIN_DELAY_SECONDS = 900
export const DEFAULT_MAX_DELAY_SECONDS = 2700

export interface StealthAsset {
  code: string
  issuer?: string
  contractId?: string
}

export interface PendingStealthSweep {
  /** Unique identifier for the pending sweep operation */
  id: string
  /** Full 56-character G-address of the ephemeral one-time stealth recipient */
  oneTimePublicKey: string
  /** Secret seed (StrKey S-address) or raw scalar hex of the ephemeral keypair */
  oneTimeSecret: string
  /** Full 56-character C-address of the destination Veil wallet contract */
  destinationContractAddress: string
  /** Amount to transfer in human-readable decimal units */
  amount: string
  /** Asset specification (native XLM or issued asset) */
  asset: StealthAsset
  /** Timestamp (ms) when this sweep was detected and scheduled */
  createdAt: number
  /** Timestamp (ms) when this sweep is scheduled to execute on-chain */
  scheduledExecutionTime: number
  /** Duration of randomized delay applied (seconds) */
  delaySeconds: number
  /** Execution status of the sweep */
  status: 'pending' | 'executing' | 'completed' | 'failed'
  /** Optional CAP-23 claimable balance ID if claimed before sweeping */
  claimableBalanceId?: string
  /** Confirmed transaction hash on the Stellar ledger */
  txHash?: string
  /** Error message if sweep submission failed */
  error?: string
}

export interface ScheduleSweepOptions {
  oneTimePublicKey: string
  oneTimeSecret: string
  destinationContractAddress: string
  amount: string
  asset?: StealthAsset
  claimableBalanceId?: string
  minDelaySeconds?: number
  maxDelaySeconds?: number
  now?: number
}

export interface ExecuteSweepOptions {
  /** When true, bypasses the remaining scheduled delay (user override) */
  force?: boolean
  /** Optional custom fee-payer keypair to sponsor transaction fee */
  feePayerKeypair?: Keypair
  /** Optional RPC server URL override */
  rpcUrl?: string
  /** Optional Horizon server URL override */
  horizonUrl?: string
  /** Optional network passphrase override */
  networkPassphrase?: string
}

/**
 * Calculate a randomized delay in seconds within [minSeconds, maxSeconds].
 * Spreads sweep execution times across hundreds of ledger closes to decouple
 * receipt from deposit.
 */
export function calculateRandomDelay(
  minSeconds = DEFAULT_MIN_DELAY_SECONDS,
  maxSeconds = DEFAULT_MAX_DELAY_SECONDS,
): number {
  const min = Math.max(0, Math.floor(minSeconds))
  const max = Math.max(min, Math.floor(maxSeconds))
  const delta = max - min
  return Math.floor(min + Math.random() * (delta + 1))
}

/**
 * Retrieve all pending or completed stealth sweeps from local namespaced storage.
 */
export function getPendingStealthSweeps(): PendingStealthSweep[] {
  try {
    const raw = walletLocal.getItem(STEALTH_PENDING_SWEEPS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Save the pending sweeps list back into local namespaced storage.
 */
export function savePendingStealthSweeps(sweeps: PendingStealthSweep[]): void {
  try {
    walletLocal.setItem(STEALTH_PENDING_SWEEPS_STORAGE_KEY, JSON.stringify(sweeps))
  } catch {
    // Local storage full or blocked
  }
}

/**
 * Schedule a new stealth payment sweep with randomized decorrelation delay.
 */
export function scheduleStealthSweep(options: ScheduleSweepOptions): PendingStealthSweep {
  const {
    oneTimePublicKey,
    oneTimeSecret,
    destinationContractAddress,
    amount,
    asset = { code: 'XLM' },
    claimableBalanceId,
    minDelaySeconds = DEFAULT_MIN_DELAY_SECONDS,
    maxDelaySeconds = DEFAULT_MAX_DELAY_SECONDS,
    now = Date.now(),
  } = options

  if (!StrKey.isValidEd25519PublicKey(oneTimePublicKey)) {
    throw new Error(`Invalid one-time stealth public key: ${oneTimePublicKey}`)
  }

  if (!StrKey.isValidContract(destinationContractAddress)) {
    throw new Error(`Destination must be a valid 56-character Soroban contract address: ${destinationContractAddress}`)
  }

  const delaySeconds = calculateRandomDelay(minDelaySeconds, maxDelaySeconds)
  const scheduledExecutionTime = now + delaySeconds * 1000

  const sweepRecord: PendingStealthSweep = {
    id: `stealth_sweep_${now}_${Math.random().toString(36).substring(2, 9)}`,
    oneTimePublicKey,
    oneTimeSecret,
    destinationContractAddress,
    amount,
    asset,
    createdAt: now,
    scheduledExecutionTime,
    delaySeconds,
    status: 'pending',
    claimableBalanceId,
  }

  const current = getPendingStealthSweeps()
  savePendingStealthSweeps([...current, sweepRecord])

  return sweepRecord
}

/**
 * Purge ephemeral secret key material from a sweep record upon successful execution.
 * Retains the transaction receipt and metadata, but wipes the spending secret.
 */
export function purgeEphemeralSecret(sweepId: string): void {
  const sweeps = getPendingStealthSweeps()
  const updated = sweeps.map((s) => {
    if (s.id === sweepId) {
      return {
        ...s,
        oneTimeSecret: '', // Securely clear private key
      }
    }
    return s
  })
  savePendingStealthSweeps(updated)
}

/**
 * Remove a sweep entry from local storage.
 */
export function removePendingStealthSweep(sweepId: string): void {
  const sweeps = getPendingStealthSweeps()
  savePendingStealthSweeps(sweeps.filter((s) => s.id !== sweepId))
}

/**
 * Execute a stealth payment sweep to move funds from the one-time classic address
 * into the user's Veil wallet contract address.
 *
 * When the transaction confirms on-chain:
 *   - The ephemeral secret key is permanently purged from storage.
 *   - The record status becomes 'completed'.
 *   - The funds are now directly spendable by the user's Veil wallet contract.
 */
export async function executeStealthSweep(
  sweepId: string,
  options: ExecuteSweepOptions = {},
): Promise<{ txHash: string }> {
  const sweeps = getPendingStealthSweeps()
  const sweep = sweeps.find((s) => s.id === sweepId)

  if (!sweep) {
    throw new Error(`Stealth sweep not found: ${sweepId}`)
  }

  if (sweep.status === 'completed') {
    return { txHash: sweep.txHash || '' }
  }

  const now = Date.now()
  if (!options.force && now < sweep.scheduledExecutionTime) {
    const remainingSeconds = Math.ceil((sweep.scheduledExecutionTime - now) / 1000)
    throw new Error(
      `Sweep is delayed for decorrelation. Scheduled in ${remainingSeconds} seconds. Pass force: true to sweep immediately.`,
    )
  }

  // Mark status as executing
  sweep.status = 'executing'
  savePendingStealthSweeps(sweeps)

  const network = getNetwork()
  const networkPassphrase = options.networkPassphrase ?? network.networkPassphrase
  const rpcUrl = options.rpcUrl ?? network.rpcUrl

  try {
    const oneTimeKeypair = Keypair.fromSecret(sweep.oneTimeSecret)
    const feePayer = options.feePayerKeypair ?? oneTimeKeypair

    const rpc = new SorobanRpc.Server(rpcUrl)
    const sacContractId =
      sweep.asset.contractId ??
      (sweep.asset.issuer
        ? new Asset(sweep.asset.code, sweep.asset.issuer).contractId(networkPassphrase)
        : getNativeAssetContractId())

    const sac = new Contract(sacContractId)
    const amountStroops = BigInt(Math.round(parseFloat(sweep.amount) * 10_000_000))

    // Load account sequence for fee-payer
    const sourceAcct = await rpc.getAccount(feePayer.publicKey())

    const tx = new TransactionBuilder(sourceAcct, {
      fee: inclusionFee(),
      networkPassphrase,
    })
      .addOperation(
        sac.call(
          'transfer',
          nativeToScVal(oneTimeKeypair.publicKey(), { type: 'address' }),
          nativeToScVal(sweep.destinationContractAddress, { type: 'address' }),
          nativeToScVal(amountStroops, { type: 'i128' }),
        ),
      )
      .setTimeout(30)
      .build()

    const sim = await rpc.simulateTransaction(tx)
    if (SorobanRpc.Api.isSimulationError(sim)) {
      throw new Error(`Simulation failed: ${sim.error}`)
    }

    const assembled = SorobanRpc.assembleTransaction(tx, sim).build()

    // Sign with fee-payer (envelope source)
    assembled.sign(feePayer)

    // If fee-payer is different from the one-time spending account, sign with the one-time keypair too
    if (feePayer.publicKey() !== oneTimeKeypair.publicKey()) {
      assembled.sign(oneTimeKeypair)
    }

    const sendResult = await rpc.sendTransaction(assembled)
    if (sendResult.status === 'ERROR') {
      throw new Error(`Transaction submission failed: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`)
    }

    const txHash = sendResult.hash

    // Update record and permanently purge secret key
    sweep.status = 'completed'
    sweep.txHash = txHash
    sweep.oneTimeSecret = ''
    sweep.error = undefined
    savePendingStealthSweeps(sweeps)

    return { txHash }
  } catch (err) {
    sweep.status = 'failed'
    sweep.error = err instanceof Error ? err.message : String(err)
    savePendingStealthSweeps(sweeps)
    throw err
  }
}

export interface StealthLinkageDisclosure {
  title: string
  summary: string
  hiddenGuarantees: string[]
  observableLinkage: string[]
  recommendation: string
}

/**
 * Returns plain-language disclosure of what an observer can and cannot correlate
 * regarding stealth payments and wallet sweep transactions.
 */
export function getStealthLinkageDisclosure(): StealthLinkageDisclosure {
  return {
    title: 'Private Receipt (Stealth Transfer)',
    summary:
      'A stealth payment hides your wallet from the sender by generating a one-time classic Stellar address. Because your Veil wallet is a smart contract governed by your passkey, the payment must be swept into your contract address to be spendable.',
    hiddenGuarantees: [
      'The sender cannot see which wallet received these funds (only your public stealth meta-address was used).',
      'Observers cannot easily correlate the receipt to your wallet using timestamps, because your wallet adds a randomized delay before sweeping.',
    ],
    observableLinkage: [
      'Once swept, anyone looking at the public Stellar blockchain ledger can see a transaction moving funds from the one-time address to your wallet contract address.',
      'If the one-time address only received this single payment, an observer analyzing the transaction graph can link the incoming payment to your wallet.',
    ],
    recommendation:
      'For complete unlinkability where even the on-chain transaction graph is decoupled, deposit funds into the Stellar Private Payments (SPP) Shielded Pool.',
  }
}
