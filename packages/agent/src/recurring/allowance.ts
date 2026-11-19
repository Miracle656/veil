import { Address, xdr } from '@stellar/stellar-sdk'
import type { PlanStopReason } from './types.js'

/**
 * On-chain allowance reader for the deployed mainnet InvisibleWallet contract.
 *
 * Deployed WASM SHA-256: b485f817469402ba4ccc24ea30077308f69589cbe0897db49087b15f58659ea5
 * Source commit: ccebd01a9b71c9857e6cd1e05dbdf6d45ea38ba2
 *
 * Storage layout pinned by the contract:
 *   DataKey::Allowance(AllowanceKey { spender, token }) -> Allowance { amount: i128, expiry: Option<u64> }
 *   Durability: persistent
 *   Expiry tolerance: CLOCK_SKEW_TOLERANCE_SECS = 60
 */

export const EXPIRY_TOLERANCE_SECS = 60n

export type AllowanceCheckResult =
  | {
      ok: true
      remainingBaseUnits: bigint
      expiry: bigint | null
    }
  | {
      ok: false
      reason: PlanStopReason
      remainingBaseUnits: bigint
      expiry: bigint | null
    }

export interface AllowanceCheckParams {
  walletAddress: string
  spenderAddress: string
  tokenContractId: string
  requiredBaseUnits: bigint
  nowSecs?: bigint
}

export interface AllowancePaymentParams {
  walletAddress: string
  spenderAddress: string
  tokenContractId: string
  destinationAddress: string
  amountBaseUnits: bigint
  idempotencyKey: string
}

export interface AllowancePaymentResult {
  /** Full 64-character Stellar transaction hash, never shortened. */
  txHash: string
}

/**
 * Abstraction for the #1339 allowance payment capability.
 *
 * Separating the interface lets the recurring top-up engine stay strictly
 * decoupled from key material in unit tests and serverless environments while
 * plugging directly into the on-chain allowance payer in production.
 */
export interface AllowancePayer {
  checkAllowance(params: AllowanceCheckParams): Promise<AllowanceCheckResult>
  payFromAllowance(params: AllowancePaymentParams): Promise<AllowancePaymentResult>
}

/**
 * Error thrown by an AllowancePayer when the wallet contract refuses a transfer
 * because the allowance is used up, expired, revoked, or insufficient.
 */
export class AllowanceRejectedError extends Error {
  readonly reason: PlanStopReason

  constructor(reason: PlanStopReason, message: string) {
    super(message)
    this.name = 'AllowanceRejectedError'
    this.reason = reason
  }
}

/** Build the Soroban LedgerKey for `DataKey::Allowance(AllowanceKey { spender, token })`. */
export function allowanceLedgerKey(
  walletAddress: string,
  spenderAddress: string,
  tokenContractId: string,
): xdr.LedgerKey {
  const allowanceKey = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('spender'),
      val: new Address(spenderAddress).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('token'),
      val: new Address(tokenContractId).toScVal(),
    }),
  ])

  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(walletAddress).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Allowance'), allowanceKey]),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  )
}

function i128ToBigInt(val: xdr.ScVal): bigint {
  const parts = val.i128()
  return (BigInt(parts.hi().toString()) << 64n) | BigInt(parts.lo().toString())
}

/** Decode `Allowance { amount: i128, expiry: Option<u64> }` from contract data. */
export function decodeAllowanceValue(val: xdr.ScVal): { amount: bigint; expiry: bigint | null } {
  let amount: bigint | undefined
  let expiry: bigint | null = null
  for (const entry of val.map() ?? []) {
    const field = entry.key().sym().toString()
    if (field === 'amount') amount = i128ToBigInt(entry.val())
    if (field === 'expiry' && entry.val().switch().name !== 'scvVoid') {
      expiry = BigInt(entry.val().u64().toString())
    }
  }
  if (amount === undefined) {
    throw new Error('Allowance ledger entry has no amount field')
  }
  return { amount, expiry }
}

/**
 * Evaluate whether a stored allowance can cover `requiredBaseUnits` at `nowSecs`,
 * matching `__check_auth` Branch 1 in commit ccebd01a.
 */
export function evaluateAllowance(
  record: { amount: bigint; expiry: bigint | null } | null,
  requiredBaseUnits: bigint,
  nowSecs: bigint,
): AllowanceCheckResult {
  if (!record) {
    return {
      ok: false,
      reason: 'allowance_revoked',
      remainingBaseUnits: 0n,
      expiry: null,
    }
  }

  // On mainnet (ccebd01a), stopping an allowance replaces it with amount=1, expiry=1.
  if (record.amount === 1n && record.expiry === 1n) {
    return {
      ok: false,
      reason: 'allowance_revoked',
      remainingBaseUnits: 0n,
      expiry: record.expiry,
    }
  }

  if (record.expiry !== null && nowSecs > record.expiry + EXPIRY_TOLERANCE_SECS) {
    return {
      ok: false,
      reason: 'allowance_expired',
      remainingBaseUnits: record.amount,
      expiry: record.expiry,
    }
  }

  if (record.amount <= 0n) {
    return {
      ok: false,
      reason: 'allowance_used_up',
      remainingBaseUnits: 0n,
      expiry: record.expiry,
    }
  }

  if (record.amount < requiredBaseUnits) {
    return {
      ok: false,
      reason: 'allowance_insufficient',
      remainingBaseUnits: record.amount,
      expiry: record.expiry,
    }
  }

  return {
    ok: true,
    remainingBaseUnits: record.amount,
    expiry: record.expiry,
  }
}

/**
 * Read the on-chain allowance for `(walletAddress, spenderAddress, tokenContractId)`
 * from Soroban RPC via `getLedgerEntries` and evaluate it against `requiredBaseUnits`.
 */
export async function checkOnChainAllowance(
  rpcUrl: string,
  params: AllowanceCheckParams,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<AllowanceCheckResult> {
  const nowSecs = params.nowSecs ?? BigInt(Math.floor(Date.now() / 1000))
  const keyB64 = allowanceLedgerKey(
    params.walletAddress,
    params.spenderAddress,
    params.tokenContractId,
  ).toXDR('base64')

  const response = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getLedgerEntries',
      params: { keys: [keyB64] },
    }),
  })

  if (!response.ok) {
    throw new Error(`Could not read on-chain allowance (RPC HTTP ${response.status})`)
  }

  const body = (await response.json()) as {
    error?: { message?: string }
    result?: { entries?: Array<{ key: string; xdr: string }> }
  }
  if (body.error) {
    throw new Error(`Could not read on-chain allowance: ${body.error.message ?? 'RPC error'}`)
  }

  const entry = body.result?.entries?.find((e) => e.key === keyB64)
  if (!entry) {
    return evaluateAllowance(null, params.requiredBaseUnits, nowSecs)
  }

  const data = xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64')
  const decoded = decodeAllowanceValue(data.contractData().val())
  return evaluateAllowance(decoded, params.requiredBaseUnits, nowSecs)
}

/**
 * Classify an error thrown during allowance payment submission to determine
 * whether the wallet contract rejected it due to allowance state.
 */
export function classifyAllowanceError(err: unknown): PlanStopReason | null {
  if (err instanceof AllowanceRejectedError) return err.reason
  const message = err instanceof Error ? err.message : String(err)
  if (/AllowanceExpired|Error\(Contract,\s*#18\)/i.test(message)) return 'allowance_expired'
  if (/InsufficientAllowance|Error\(Contract,\s*#17\)/i.test(message)) return 'allowance_insufficient'
  if (/allowance.*revoked/i.test(message)) return 'allowance_revoked'
  if (/allowance.*used.?up|allowance.*exhausted/i.test(message)) return 'allowance_used_up'
  return null
}
