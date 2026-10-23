/**
 * Sponsored submission and cost measurement for private transactions (#725).
 *
 * Fee-bumps an SPP transaction from the wallet's own fee payer so the user does
 * not need a funded G-account, then — only behind the diagnostics opt-in —
 * records the two numbers `docs/PRIVACY_COST.md` §2 is built from: the charged
 * fee and the CPU instruction count. Never the hash, the addresses or the
 * amount.
 *
 * Lives beside, not inside, `./client.ts`: that file is the SPP client wrapper
 * (#774) and the SDK submits its own transactions, so this helper has no call
 * site in the shield/send path yet. Wiring it in is follow-on work.
 *
 * Because nothing calls it yet, the figures in §2 come from the pool itself:
 * {@link samplePrivateTransactionCosts} reads the successful `transact` calls
 * on the SPP pools from RPC and {@link summarizeCosts} reduces them to the
 * median and range the document quotes. Both the telemetry and the sampler
 * read a transaction through {@link readTransactionCost}, so the two cannot
 * disagree on what "the fee" of a private transaction is.
 */
import { Address, Transaction, rpc as SorobanRpc, xdr } from '@stellar/stellar-sdk'
import * as Sentry from '@sentry/nextjs'

import { buildSponsoredFeeBumpTransaction } from '../feeBump'
import { getSentryOptIn } from '../sentry'

/** Submit an SPP transaction using the wallet's normal fee-payer account. */
export async function submitPrivateTransaction(params: {
  innerTx: Transaction
  feePayerSecret: string
  rpcUrl: string
  networkPassphrase: string
}): Promise<string> {
  const rpc = new SorobanRpc.Server(params.rpcUrl)
  const submission = buildSponsoredFeeBumpTransaction({
    innerTransaction: params.innerTx,
    networkPassphrase: params.networkPassphrase,
    sponsor: { secret: params.feePayerSecret },
  })

  const sent = await rpc.sendTransaction(submission)
  if (sent.status === 'ERROR') {
    throw new Error(
      `Private transaction rejected: ${sent.errorResult?.toXDR('base64') ?? 'unknown'}`
    )
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await rpc.getTransaction(sent.hash)
    if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
      if (result.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`Private transaction failed: ${result.status}`)
      }

      recordPrivateTransactionCost(result)
      return sent.hash
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }

  throw new Error('Private transaction timed out. Check its status before retrying.')
}

/** Telemetry is opt-in and contains only the charged fee and CPU instruction count. */
function recordPrivateTransactionCost(result: SorobanRpc.Api.GetSuccessfulTransactionResponse): void {
  if (!getSentryOptIn()) return

  try {
    const cost = readTransactionCost(result)
    // No instruction count means this was not a Soroban transaction we can
    // measure: send nothing rather than half a sample.
    if (!cost || cost.instructions === null) return

    Sentry.captureMessage('Private transaction cost sample', {
      level: 'info',
      extra: {
        feeCharged: String(cost.feeChargedStroops),
        instructions: String(cost.instructions),
      },
    })
  } catch {
    // A diagnostics failure must never change the result of a confirmed payment.
  }
}

// ---------------------------------------------------------------------------
// Reading one transaction
// ---------------------------------------------------------------------------

/** What one confirmed private transaction cost. */
export interface PrivateTransactionCost {
  /** Fee actually charged, in stroops (for a fee bump, what the sponsor paid). */
  feeChargedStroops: number
  /** CPU instructions the transaction declared, or null if it carries no Soroban data. */
  instructions: number | null
}

/** The inner `Transaction` body of an envelope, unwrapping a fee bump. */
function transactionBody(envelope: xdr.TransactionEnvelope): xdr.Transaction | null {
  switch (envelope.switch().name) {
    case 'envelopeTypeTx':
      return envelope.v1().tx()
    case 'envelopeTypeTxFeeBump':
      return envelope.feeBump().tx().innerTx().v1().tx()
    default:
      return null
  }
}

/**
 * The charged fee and instruction count of a confirmed transaction, or null if
 * the RPC answer has no result to read a fee from.
 *
 * The instruction count is read from the envelope's Soroban data. It used to be
 * read from a `sorobanData` property on the SDK's `Transaction`, which does not
 * exist, so the opt-in telemetry silently recorded nothing.
 */
export function readTransactionCost(
  response: Pick<SorobanRpc.Api.GetSuccessfulTransactionResponse, 'envelopeXdr' | 'resultXdr'>
): PrivateTransactionCost | null {
  const fee = response.resultXdr?.feeCharged()
  if (fee === undefined) return null

  const ext = response.envelopeXdr ? transactionBody(response.envelopeXdr)?.ext() : undefined
  const instructions = ext && ext.switch() === 1 ? ext.sorobanData().resources().instructions() : null

  return { feeChargedStroops: Number(fee.toString()), instructions }
}

/** Whether an envelope invokes `transact` on one of `poolContractIds`. */
export function isPoolTransact(
  envelope: xdr.TransactionEnvelope,
  poolContractIds: readonly string[]
): boolean {
  const body = transactionBody(envelope)
  if (!body) return false

  return body.operations().some((op) => {
    if (op.body().switch().name !== 'invokeHostFunction') return false
    const fn = op.body().invokeHostFunctionOp().hostFunction()
    if (fn.switch().name !== 'hostFunctionTypeInvokeContract') return false
    const call = fn.invokeContract()
    return (
      call.functionName().toString() === 'transact' &&
      poolContractIds.includes(Address.fromScAddress(call.contractAddress()).toString())
    )
  })
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Lowest, highest and median of a set of measurements. */
export interface CostSummary {
  count: number
  min: number
  max: number
  /** For an even count, the mean of the two middle values (so it can be a half). */
  median: number
}

/**
 * Summarise a set of measurements, or return null when there are none.
 *
 * Null, not zeros: an empty sample has no median, and a 0 here would read as
 * "private transactions are free" in the document that quotes it.
 */
export function summarizeCosts(values: readonly number[]): CostSummary | null {
  if (values.length === 0) return null
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new RangeError('Cost measurements must be finite, non-negative numbers')
  }

  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2

  return { count: sorted.length, min: sorted[0], max: sorted[sorted.length - 1], median }
}

// ---------------------------------------------------------------------------
// Sampling from a live pool
// ---------------------------------------------------------------------------

/** The RPC calls the sampler makes. `rpc.Server` satisfies it. */
export interface PoolCostRpc {
  getHealth(): Promise<{ latestLedger: number; oldestLedger: number }>
  getEvents(
    request: SorobanRpc.Api.GetEventsRequest
  ): Promise<{ events: Array<{ txHash: string }>; cursor: string; latestLedger: number }>
  getTransaction(hash: string): Promise<SorobanRpc.Api.GetTransactionResponse>
}

/** What a sampling run found. */
export interface PoolCostSample {
  /** Charged fee in stroops over the sampled transactions; null when none were sampled. */
  fee: CostSummary | null
  /** Declared CPU instructions over the sampled transactions that carry them; null when none. */
  instructions: CostSummary | null
  /** First ledger scanned. */
  fromLedger: number
  /** Last ledger the event scan reached. */
  toLedger: number
  /** Distinct transactions that emitted a pool event. */
  seen: number
  /** Successful `transact` calls measured: the `count` behind `fee`. */
  sampled: number
  /** Seen but excluded: failed, or not a `transact` call on a pool. */
  excluded: number
  /** Seen but not measured, because looking the transaction up failed. */
  unavailable: number
  /**
   * False when any events page or lookup failed, or the scan stopped early.
   * A figure from an incomplete sample covers fewer transactions than the
   * pool actually had and must not be quoted as the full window.
   */
  complete: boolean
  /** Why the sample is incomplete, one entry per failure. */
  errors: string[]
}

/** Ledgers to stay clear of the retention edge, which moves while we scan. */
const RETENTION_MARGIN_LEDGERS = 120

/** The ledger an RPC events cursor points at (`<TOID>-<event index>`; the ledger is the TOID's top 32 bits). */
function cursorLedger(cursor: string): number | null {
  const toid = cursor.split('-')[0]
  if (!/^\d+$/.test(toid)) return null
  return Number(BigInt(toid) >> BigInt(32))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Sample the cost of private transactions from a live pool.
 *
 * Lists every event the pools emitted from `startLedger` (default: the oldest
 * ledger RPC still holds, i.e. about the last 7 days) to the tip, looks each
 * transaction up, and measures the successful `transact` calls on the pools.
 *
 * A third party answers this, and it can answer incompletely. The rules:
 * - If the event listing fails before any page is read, this rejects: there
 *   is nothing to report.
 * - If a later page or a transaction lookup fails, the result is returned
 *   with `complete: false` and the failures in `errors`.
 * - If nothing is sampled, `fee` and `instructions` are null, never zero.
 */
export async function samplePrivateTransactionCosts(params: {
  rpc: PoolCostRpc
  poolContractIds: readonly string[]
  startLedger?: number
  /** Events per page (RPC caps this at 10,000). */
  pageLimit?: number
  /** Safety stop for the event scan; RPC scans a bounded range of ledgers per page. */
  maxPages?: number
}): Promise<PoolCostSample> {
  const { rpc, poolContractIds } = params
  const limit = params.pageLimit ?? 1_000
  const maxPages = params.maxPages ?? 100
  if (poolContractIds.length === 0) throw new Error('No pool contract ids to sample')

  const fromLedger =
    params.startLedger ?? (await rpc.getHealth()).oldestLedger + RETENTION_MARGIN_LEDGERS
  const filters: SorobanRpc.Api.EventFilter[] = [
    { type: 'contract', contractIds: [...poolContractIds] },
  ]

  const errors: string[] = []
  const hashes = new Set<string>()
  let toLedger = fromLedger
  let finished = false
  let request: SorobanRpc.Api.GetEventsRequest = { filters, startLedger: fromLedger, limit }

  for (let page = 0; page < maxPages; page += 1) {
    let response: Awaited<ReturnType<PoolCostRpc['getEvents']>>
    try {
      response = await rpc.getEvents(request)
    } catch (error) {
      if (page === 0) throw new Error(`Could not list pool events: ${errorMessage(error)}`)
      errors.push(`Events page ${page + 1} failed: ${errorMessage(error)}`)
      break
    }

    for (const event of response.events) hashes.add(event.txHash)

    const reached = cursorLedger(response.cursor)
    if (reached === null) {
      errors.push(`Events page ${page + 1} returned an unreadable cursor`)
      break
    }
    toLedger = Math.max(toLedger, Math.min(reached, response.latestLedger))

    // A short page only means "done" once the scan has reached the tip: RPC
    // scans a bounded range of ledgers per request and returns short (even
    // empty) pages long before that.
    if (response.events.length < limit && reached >= response.latestLedger) {
      finished = true
      break
    }
    request = { filters, cursor: response.cursor, limit }
  }
  if (!finished && errors.length === 0) {
    errors.push(`Event scan stopped after ${maxPages} pages, before reaching the latest ledger`)
  }

  const fees: number[] = []
  const instructions: number[] = []
  let excluded = 0
  let unavailable = 0

  // One at a time: this runs against a public RPC, and the pools are small.
  for (const hash of hashes) {
    let tx: SorobanRpc.Api.GetTransactionResponse
    try {
      tx = await rpc.getTransaction(hash)
    } catch (error) {
      unavailable += 1
      errors.push(`Transaction lookup failed: ${errorMessage(error)}`)
      continue
    }

    if (tx.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
      // It emitted an event, so it exists; RPC has dropped it or is behind.
      unavailable += 1
      errors.push('Transaction lookup returned NOT_FOUND for a transaction that emitted a pool event')
      continue
    }
    if (
      tx.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS ||
      !isPoolTransact(tx.envelopeXdr, poolContractIds)
    ) {
      excluded += 1
      continue
    }

    const cost = readTransactionCost(tx)
    if (!cost) {
      unavailable += 1
      errors.push('Transaction lookup returned no result to read a fee from')
      continue
    }
    fees.push(cost.feeChargedStroops)
    if (cost.instructions !== null) instructions.push(cost.instructions)
  }

  return {
    fee: summarizeCosts(fees),
    instructions: summarizeCosts(instructions),
    fromLedger,
    toLedger,
    seen: hashes.size,
    sampled: fees.length,
    excluded,
    unavailable,
    complete: errors.length === 0,
    errors,
  }
}

const STROOPS_PER_XLM = 10_000_000

/** Stroops as XLM, to the stroop, without trailing zeros. */
function formatXlm(stroops: number): string {
  return (stroops / STROOPS_PER_XLM).toFixed(7).replace(/\.?0+$/, '')
}

/** A plain-text report of a sample, in the units `docs/PRIVACY_COST.md` §2 uses. */
export function formatPoolCostReport(sample: PoolCostSample): string {
  const lines = [`Ledgers ${sample.fromLedger}-${sample.toLedger}`]

  if (sample.fee) {
    lines.push(
      `Fee per private transaction: ${formatXlm(sample.fee.min)}-${formatXlm(sample.fee.max)} XLM, ` +
        `median ${formatXlm(sample.fee.median)} (${sample.fee.count} successful transact calls)`
    )
  } else {
    lines.push('Fee per private transaction: no figure (no successful transact calls sampled)')
  }

  lines.push(
    sample.instructions
      ? `CPU per transaction: up to ${sample.instructions.max} instructions`
      : 'CPU per transaction: no figure'
  )
  lines.push(
    `Seen ${sample.seen}, sampled ${sample.sampled}, excluded ${sample.excluded}, unavailable ${sample.unavailable}`
  )

  if (!sample.complete) {
    lines.push('INCOMPLETE: do not quote these figures as the full window.')
    for (const error of sample.errors) lines.push(`  - ${error}`)
  }
  return lines.join('\n')
}
