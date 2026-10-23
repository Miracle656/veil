/**
 * Token allowances held by this wallet (#1187).
 *
 * `approve(spender, token, amount, expiry)` on the wallet contract grants a
 * spender a standing right to move the wallet's tokens: `__check_auth` Branch 1
 * debits it on every `transfer` the spender authorises. It is real authority
 * over the user's money, so the user must be able to see it.
 *
 * # Why the list is built from candidates
 *
 * The contract stores each allowance under its own persistent ledger key,
 * `DataKey::Allowance(AllowanceKey { spender, token })`, keeps no index, and
 * `approve` emits no event. Nothing on chain can answer "which allowances does
 * this wallet have?". What *can* be answered exactly is "is there an allowance
 * for this (spender, token)?", by reading that key. So the list is every
 * candidate pair we know of, read from the ledger in one batched
 * `getLedgerEntries` call:
 *
 *   - pairs recorded on this device when a WalletConnect request that calls
 *     `approve` on this wallet was signed ({@link recordApprovalsInXdr});
 *   - the contracts this wallet itself works with, crossed with the known tokens;
 *   - any spender the user asks us to check.
 *
 * An allowance granted through some other app or device is found only once its
 * spender is checked. The screen says so rather than implying the list is total.
 *
 * # What the deployed contract can and cannot do
 *
 * Every wallet on mainnet runs the code built from commit
 * ccebd01a9b71c9857e6cd1e05dbdf6d45ea38ba2 and cannot be upgraded. On it:
 *
 *   - `approve` overwrites amount *and* expiry together, and panics on an
 *     amount <= 0. There is no revoke entry point (V320, #1172). An allowance
 *     can therefore never be removed, only replaced.
 *   - An allowance with `expiry = Some(e)` is rejected once
 *     `ledger time > e + 60` (`auth::expiration::is_expired`).
 *
 * So the honest controls are: reduce the amount (keeping its expiry — omitting
 * it would make a time-limited allowance permanent), or replace it with the
 * smallest amount and an expiry already in the past, which leaves the record on
 * chain but makes every transfer through it fail with `AllowanceExpired`.
 * Neither is described as removal.
 */

import { Address, xdr } from '@stellar/stellar-sdk'

/**
 * `CLOCK_SKEW_TOLERANCE_SECS` in the deployed contract
 * (contracts/invisible_wallet/src/auth/expiration.rs): an expiry is enforced
 * only once ledger time is past it by more than this.
 */
export const EXPIRY_TOLERANCE_SECS = 60n

/**
 * Whether the deployed contract can delete an allowance. False until V320
 * (#1172) ships in a new factory; wallets already deployed keep this false for
 * good. Nothing in the UI may offer "remove" or "revoke" while it is false.
 */
export const CONTRACT_CAN_REVOKE = false

/** `getLedgerEntries` accepts at most this many keys per request. */
const MAX_KEYS_PER_REQUEST = 200

export type AllowanceStatus =
  /** Can still move funds now. */
  | 'active'
  /** Past its expiry: every transfer through it fails. Still stored on chain. */
  | 'expired'
  /** Fully spent: amount is 0, so every transfer through it fails. */
  | 'used-up'

export interface AllowancePair {
  spender: string
  token: string
}

export interface Allowance extends AllowancePair {
  /** Remaining amount in the token's base units. */
  amount: bigint
  /** Unix seconds, or null for an allowance that never expires. */
  expiry: bigint | null
  status: AllowanceStatus
  /**
   * The ledger entry's TTL has run out. The allowance is still valid: anyone,
   * including the spender, can restore the entry and then use it.
   */
  archived: boolean
}

/** The ledger key the wallet contract stores this allowance under. */
export function allowanceLedgerKey(wallet: string, spender: string, token: string): xdr.LedgerKey {
  // #[contracttype] encodes DataKey::Allowance(AllowanceKey { spender, token })
  // as Vec[Symbol("Allowance"), Map{ spender, token }], fields in name order.
  // The contract's storage tests pin this shape (storage/tests.rs).
  const allowanceKey = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('spender'), val: new Address(spender).toScVal() }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('token'), val: new Address(token).toScVal() }),
  ])
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(wallet).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Allowance'), allowanceKey]),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  )
}

function i128ToBigInt(val: xdr.ScVal): bigint {
  const parts = val.i128()
  return (BigInt(parts.hi().toString()) << 64n) | BigInt(parts.lo().toString())
}

/** Decode the stored `Allowance { amount: i128, expiry: Option<u64> }`. */
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
  if (amount === undefined) throw new Error('Allowance entry has no amount')
  return { amount, expiry }
}

/** Status as the deployed `__check_auth` would judge it at `nowSecs`. */
export function allowanceStatus(amount: bigint, expiry: bigint | null, nowSecs: bigint): AllowanceStatus {
  if (expiry !== null && nowSecs > expiry + EXPIRY_TOLERANCE_SECS) return 'expired'
  if (amount <= 0n) return 'used-up'
  return 'active'
}

export interface FetchAllowancesOptions {
  /** Current Unix time in seconds; defaults to the device clock. */
  nowSecs?: bigint
  fetchImpl?: typeof fetch
}

interface LedgerEntriesResult {
  latestLedger: number
  entries?: Array<{ key: string; xdr: string; liveUntilLedgerSeq?: number }>
}

async function getLedgerEntries(
  rpcUrl: string,
  keys: string[],
  fetchImpl: typeof fetch,
): Promise<LedgerEntriesResult> {
  const response = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLedgerEntries', params: { keys } }),
  })
  if (!response.ok) throw new Error(`Could not read allowances (RPC returned HTTP ${response.status})`)
  const body = await response.json()
  if (body.error) throw new Error(`Could not read allowances: ${body.error.message ?? JSON.stringify(body.error)}`)
  return body.result as LedgerEntriesResult
}

/**
 * Read every candidate pair from the ledger. Pairs with no allowance are
 * dropped; expired and used-up ones are kept and marked.
 */
export async function fetchAllowances(
  rpcUrl: string,
  wallet: string,
  pairs: AllowancePair[],
  { nowSecs = BigInt(Math.floor(Date.now() / 1000)), fetchImpl = globalThis.fetch }: FetchAllowancesOptions = {},
): Promise<Allowance[]> {
  const unique = dedupePairs(pairs)
  const byKey = new Map<string, AllowancePair>()
  for (const pair of unique) {
    byKey.set(allowanceLedgerKey(wallet, pair.spender, pair.token).toXDR('base64'), pair)
  }

  const keys = [...byKey.keys()]
  const found: Allowance[] = []
  for (let i = 0; i < keys.length; i += MAX_KEYS_PER_REQUEST) {
    const result = await getLedgerEntries(rpcUrl, keys.slice(i, i + MAX_KEYS_PER_REQUEST), fetchImpl)
    for (const entry of result.entries ?? []) {
      const pair = byKey.get(entry.key)
      if (!pair) continue
      const data = xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64')
      const { amount, expiry } = decodeAllowanceValue(data.contractData().val())
      found.push({
        ...pair,
        amount,
        expiry,
        status: allowanceStatus(amount, expiry, nowSecs),
        archived: entry.liveUntilLedgerSeq !== undefined && entry.liveUntilLedgerSeq < result.latestLedger,
      })
    }
  }

  // Active first, then by spender, so the ones that can still move money lead.
  const rank: Record<AllowanceStatus, number> = { active: 0, 'used-up': 1, expired: 2 }
  return found.sort(
    (a, b) => rank[a.status] - rank[b.status] || a.spender.localeCompare(b.spender) || a.token.localeCompare(b.token),
  )
}

export function dedupePairs(pairs: AllowancePair[]): AllowancePair[] {
  const seen = new Set<string>()
  const out: AllowancePair[] = []
  for (const pair of pairs) {
    const id = `${pair.spender}:${pair.token}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push(pair)
  }
  return out
}

// ── Pairs this device has seen ────────────────────────────────────────────────

export interface PairStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function storageKey(wallet: string): string {
  return `veil_allowance_pairs:${wallet}`
}

export function loadTrackedPairs(store: PairStore, wallet: string): AllowancePair[] {
  try {
    const parsed = JSON.parse(store.getItem(storageKey(wallet)) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (p): p is AllowancePair => typeof p?.spender === 'string' && typeof p?.token === 'string',
    )
  } catch {
    return []
  }
}

export function trackPairs(store: PairStore, wallet: string, pairs: AllowancePair[]): void {
  if (pairs.length === 0) return
  const merged = dedupePairs([...loadTrackedPairs(store, wallet), ...pairs])
  store.setItem(storageKey(wallet), JSON.stringify(merged))
}

/**
 * The (spender, token) of every `approve` call on `wallet` inside a
 * transaction. Used to remember allowances granted through WalletConnect.
 */
export function approvalsInTransaction(envelope: xdr.TransactionEnvelope, wallet: string): AllowancePair[] {
  const tx =
    envelope.switch().name === 'envelopeTypeTxFeeBump'
      ? envelope.feeBump().tx().innerTx().v1().tx()
      : envelope.switch().name === 'envelopeTypeTx'
        ? envelope.v1().tx()
        : null
  if (!tx) return []

  const pairs: AllowancePair[] = []
  for (const op of tx.operations()) {
    if (op.body().switch().name !== 'invokeHostFunction') continue
    const fn = op.body().invokeHostFunctionOp().hostFunction()
    if (fn.switch().name !== 'hostFunctionTypeInvokeContract') continue
    const call = fn.invokeContract()
    if (call.functionName().toString() !== 'approve') continue
    if (Address.fromScAddress(call.contractAddress()).toString() !== wallet) continue
    const [spender, token] = call.args()
    if (!spender || !token) continue
    try {
      pairs.push({
        spender: Address.fromScVal(spender).toString(),
        token: Address.fromScVal(token).toString(),
      })
    } catch {
      // Not addresses: the contract would reject this call anyway.
    }
  }
  return pairs
}

export function recordApprovalsInXdr(
  store: PairStore,
  wallet: string | null,
  txXdr: string,
): AllowancePair[] {
  if (!wallet) return []
  let pairs: AllowancePair[]
  try {
    pairs = approvalsInTransaction(xdr.TransactionEnvelope.fromXDR(txXdr, 'base64'), wallet)
  } catch {
    return []
  }
  trackPairs(store, wallet, pairs)
  return pairs
}

// ── What the user can do ──────────────────────────────────────────────────────

/** The `approve` call each control makes: the replacement amount and expiry. */
export interface Replacement {
  amount: bigint
  expiry: bigint | null
}

export type AllowanceAction = 'reduce' | 'stop'

/**
 * Button labels. None may say remove, revoke or delete while
 * {@link CONTRACT_CAN_REVOKE} is false: the deployed contract cannot do that.
 */
export const ACTION_LABELS: Record<AllowanceAction, string> = {
  reduce: 'Lower the limit',
  stop: 'Stop it now',
}

/**
 * Controls offered for an allowance. Only an active one has anything to stop:
 * an expired or used-up allowance already cannot move funds, and replacing it
 * would only create a new record.
 */
export function availableActions(a: Pick<Allowance, 'status'>): AllowanceAction[] {
  return a.status === 'active' ? ['reduce', 'stop'] : []
}

/**
 * Lower an allowance's amount. Keeps its expiry, because `approve` replaces
 * the expiry too: dropping it would turn a time-limited allowance permanent.
 */
export function reduceReplacement(
  a: Pick<Allowance, 'amount' | 'expiry'>,
  newAmount: bigint,
): Replacement | { error: string } {
  if (newAmount <= 0n) return { error: 'The wallet contract cannot set a limit of zero. Use Stop it now instead.' }
  if (newAmount >= a.amount) return { error: 'Enter an amount lower than the current limit.' }
  return { amount: newAmount, expiry: a.expiry }
}

/**
 * The strongest thing the deployed contract allows: the smallest positive
 * amount (it panics on zero) with an expiry of 0, which every ledger time is
 * past by more than {@link EXPIRY_TOLERANCE_SECS}. `__check_auth` then rejects
 * every transfer through it with `AllowanceExpired`. The record stays on chain.
 */
export const STOP_REPLACEMENT: Replacement = { amount: 1n, expiry: 0n }

// ── Amount input ──────────────────────────────────────────────────────────────

/** Parse a user-typed decimal amount into base units, or null if invalid. */
export function parseUnits(input: string, decimals: number): bigint | null {
  const trimmed = input.trim()
  const match = /^(\d+)(?:\.(\d*))?$/.exec(trimmed)
  if (!match) return null
  const [, whole, fraction = ''] = match
  if (fraction.length > decimals) return null
  return BigInt(whole + fraction.padEnd(decimals, '0'))
}
