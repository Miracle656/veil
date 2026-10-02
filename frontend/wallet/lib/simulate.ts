import {
  Address,
  StrKey,
  TransactionBuilder,
  rpc as SorobanRpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'
import { getNetwork } from './network'

/**
 * Transaction simulation preview (issue #342).
 *
 * Before the wallet shows a passkey prompt we simulate the Soroban transaction
 * with `simulateTransaction`, decode its contract events and return value, and
 * surface a humanized summary ("you send 50 USDC", "you receive at least 51.2
 * XLM"). A simulation that fails is a hard block — the caller must refuse to
 * sign.
 */

// Classic Stellar assets and their Stellar Asset Contract (SAC) wrappers use 7
// decimals. Soroban-native tokens may differ; callers can override per token.
export const DEFAULT_TOKEN_DECIMALS = 7

/** Minimal surface of `rpc.Server` we depend on (injectable for tests). */
export interface SimulateCapable {
  simulateTransaction(
    tx: Parameters<SorobanRpc.Server['simulateTransaction']>[0],
  ): Promise<SorobanRpc.Api.SimulateTransactionResponse>
}

export interface DecodedEvent {
  type: string
  contractId: string | null
  topics: unknown[]
  data: unknown
}

export interface TokenTransfer {
  token: string | null
  from: string | null
  to: string | null
  amount: bigint
}

export interface PricedTransfer extends TokenTransfer {
  decimals: number
  display: string
}

export interface ContractInvocation {
  contractId: string
  functionName: string
  args: xdr.ScVal[]
}

export interface SwapPreview {
  amountIn: bigint | null
  minReceive: bigint | null
  estimatedReceive: bigint | null
  decimals: number
  minReceiveDisplay: string | null
  estimatedReceiveDisplay: string | null
}

export type TxPreview =
  | {
      status: 'ready'
      functionName: string | null
      contractId: string | null
      transfers: PricedTransfer[]
      swap: SwapPreview | null
      feeStroops: string | null
      returnValue: unknown
      events: DecodedEvent[]
    }
  | { status: 'blocked'; error: string }

export interface PreviewTransactionParams {
  /** Unsigned Soroban transaction XDR (base64). */
  xdr: string
  rpcUrl?: string
  networkPassphrase?: string
  /** Soroban RPC client; defaults to a real server built from `rpcUrl`. */
  server?: SimulateCapable
  /** Per-token decimal overrides, keyed by contract id. */
  tokenDecimals?: Record<string, number>
}

/**
 * Simulates a transaction and returns a humanized preview. A failed simulation
 * resolves to `{ status: 'blocked' }` so the UI can hard-block signing rather
 * than throwing.
 */
export async function previewTransaction(
  params: PreviewTransactionParams,
): Promise<TxPreview> {
  const network = getNetwork()
  const networkPassphrase = params.networkPassphrase ?? network.networkPassphrase
  const rpcUrl = params.rpcUrl ?? network.rpcUrl

  let tx: ReturnType<typeof TransactionBuilder.fromXDR>
  try {
    tx = TransactionBuilder.fromXDR(params.xdr, networkPassphrase)
  } catch (err) {
    return { status: 'blocked', error: `Malformed transaction: ${errorMessage(err)}` }
  }

  const server = params.server ?? new SorobanRpc.Server(rpcUrl)

  let sim: SorobanRpc.Api.SimulateTransactionResponse
  try {
    sim = await server.simulateTransaction(tx)
  } catch (err) {
    return { status: 'blocked', error: `Simulation failed: ${errorMessage(err)}` }
  }

  if (SorobanRpc.Api.isSimulationError(sim)) {
    return { status: 'blocked', error: sim.error }
  }

  const invocation = extractInvocation(tx)
  const events = decodeEvents(sim.events ?? [])
  const decimalsFor = (token: string | null): number => {
    const override = token ? params.tokenDecimals?.[token] : undefined
    return override ?? DEFAULT_TOKEN_DECIMALS
  }

  const transfers: PricedTransfer[] = decodeTransfers(events).map((t) => {
    const decimals = decimalsFor(t.token)
    return { ...t, decimals, display: formatAmount(t.amount, decimals) }
  })

  const returnValue = decodeReturnValue(sim)
  const swap = invocation
    ? buildSwapPreview(invocation, returnValue, decimalsFor(invocation.contractId))
    : null

  return {
    status: 'ready',
    functionName: invocation?.functionName ?? null,
    contractId: invocation?.contractId ?? null,
    transfers,
    swap,
    feeStroops: 'minResourceFee' in sim ? sim.minResourceFee : null,
    returnValue,
    events,
  }
}

/** Reads the first `InvokeContract` host function from a (possibly fee-bumped) tx. */
export function extractInvocation(
  tx: ReturnType<typeof TransactionBuilder.fromXDR>,
): ContractInvocation | null {
  const inner = 'innerTransaction' in tx ? tx.innerTransaction : tx
  const op = inner.operations?.[0]
  if (!op || op.type !== 'invokeHostFunction') return null

  try {
    const func = op.func
    if (func.switch().name !== 'hostFunctionTypeInvokeContract') return null
    const ic = func.invokeContract()
    return {
      contractId: Address.fromScAddress(ic.contractAddress()).toString(),
      functionName: ic.functionName().toString(),
      args: ic.args(),
    }
  } catch {
    return null
  }
}

/** Decodes diagnostic events into plain `{ topics, data }` objects. */
export function decodeEvents(events: xdr.DiagnosticEvent[]): DecodedEvent[] {
  const decoded: DecodedEvent[] = []
  for (const diagnostic of events) {
    try {
      const event = diagnostic.event()
      const contractIdBuf = event.contractId()
      const body = event.body().v0()
      decoded.push({
        type: event.type().name,
        contractId: contractIdBuf
          ? StrKey.encodeContract(contractIdBuf as unknown as Buffer)
          : null,
        topics: body.topics().map(safeScValToNative),
        data: safeScValToNative(body.data()),
      })
    } catch {
      // Skip events we cannot decode rather than failing the whole preview.
    }
  }
  return decoded
}

/**
 * Extracts SAC-style `transfer` events. The amount lives in the event data,
 * either as a raw i128 or (protocol 22+) a map containing `amount`.
 */
export function decodeTransfers(events: DecodedEvent[]): TokenTransfer[] {
  const transfers: TokenTransfer[] = []
  for (const event of events) {
    if (!Array.isArray(event.topics) || event.topics[0] !== 'transfer') continue
    const amount = toBigInt(extractAmount(event.data))
    if (amount === null) continue
    transfers.push({
      token: event.contractId,
      from: asAddressString(event.topics[1]),
      to: asAddressString(event.topics[2]),
      amount,
    })
  }
  return transfers
}

/**
 * Builds a swap summary for router-style invocations
 * (`swap_exact_tokens_for_tokens(amount_in, amount_out_min, ...)`), exposing the
 * guaranteed minimum receive (the slippage floor) and the simulated estimate.
 */
export function buildSwapPreview(
  invocation: ContractInvocation,
  returnValue: unknown,
  decimals: number,
): SwapPreview | null {
  if (!/swap/i.test(invocation.functionName)) return null

  const amountIn = toBigInt(safeScValToNative(invocation.args[0]))
  const minReceive = toBigInt(safeScValToNative(invocation.args[1]))
  const estimatedReceive = estimatedReceiveFromReturn(returnValue)

  if (amountIn === null && minReceive === null && estimatedReceive === null) {
    return null
  }

  return {
    amountIn,
    minReceive,
    estimatedReceive,
    decimals,
    minReceiveDisplay: minReceive === null ? null : formatAmount(minReceive, decimals),
    estimatedReceiveDisplay:
      estimatedReceive === null ? null : formatAmount(estimatedReceive, decimals),
  }
}

/** Formats a base-unit integer amount into a human decimal string. */
export function formatAmount(raw: bigint, decimals: number): string {
  if (decimals <= 0) return raw.toString()

  const negative = raw < 0n
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '')
  const sign = negative ? '-' : ''
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`
}

// ── internal helpers ────────────────────────────────────────────────────────

function decodeReturnValue(sim: SorobanRpc.Api.SimulateTransactionResponse): unknown {
  const retval = 'result' in sim ? sim.result?.retval : undefined
  return retval ? safeScValToNative(retval) : null
}

function estimatedReceiveFromReturn(returnValue: unknown): bigint | null {
  // Router swaps return the per-hop amounts; the last entry is the final out.
  if (Array.isArray(returnValue) && returnValue.length > 0) {
    return toBigInt(returnValue[returnValue.length - 1])
  }
  return toBigInt(returnValue)
}

function extractAmount(data: unknown): unknown {
  if (data !== null && typeof data === 'object' && 'amount' in data) {
    return (data as { amount: unknown }).amount
  }
  return data
}

function safeScValToNative(value: xdr.ScVal): unknown {
  try {
    return scValToNative(value)
  } catch {
    return null
  }
}

function toBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value)
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
  return null
}

function asAddressString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
