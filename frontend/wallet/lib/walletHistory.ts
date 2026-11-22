/**
 * Turns a page of Horizon OPERATIONS into the rows the history list shows.
 *
 * Operations, not payments. Horizon's payments feed leaves out
 * `invoke_host_function`, so everything the wallet contract did was missing
 * from the web history: cash-outs, sends from the wallet, swaps, and money
 * arriving from another contract. The spending account pays for those
 * transactions, so they are all in its operations feed, each with the full
 * list of balance changes.
 *
 * This is the web counterpart of `frontend/mobile/lib/horizonActivity.ts`. The
 * two apps showed different histories for the same wallet because only the
 * phone read operations.
 */
import type { TxRecord } from '@/components/TxDetailSheet'

/** How many operations to ask Horizon for per page. Many yield no row. */
export const HISTORY_PAGE_SIZE = 100

/** One entry of `asset_balance_changes` on an invoke_host_function operation. */
export interface BalanceChange {
  asset_type?: string
  asset_code?: string
  type?: string
  from?: string
  to?: string
  amount?: string
}

/** The fields of a Horizon operation record this file reads. */
export interface HorizonOperation {
  id: string
  type: string
  created_at: string
  transaction_hash: string
  transaction?: { memo?: string }
  // payment, path payment
  from?: string
  to?: string
  amount?: string
  asset_type?: string
  asset_code?: string
  source_amount?: string
  source_asset_type?: string
  source_asset_code?: string
  // create_account
  funder?: string
  account?: string
  starting_balance?: string
  // invoke_host_function
  asset_balance_changes?: BalanceChange[]
}

function assetOf(type: string | undefined, code: string | undefined): string {
  return type === 'native' || !type ? 'XLM' : code ?? 'XLM'
}

function seconds(createdAt: string): number {
  const ms = new Date(createdAt).getTime()
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0
}

type Base = Pick<TxRecord, 'id' | 'timestamp' | 'hash'>

/**
 * One contract call as one row.
 *
 * A call that both spends and receives is a swap. Legs between two addresses
 * that are both ours (the wallet topping up its spending account), or neither
 * ours (a router's internal hops), are not shown.
 */
function invocationToRecord(changes: BalanceChange[], mine: Set<string>, base: Base): TxRecord | null {
  const isMine = (address: string | undefined) => !!address && mine.has(address)
  const sent = changes.filter((c) => isMine(c.from) && !isMine(c.to))
  const received = changes.filter((c) => isMine(c.to) && !isMine(c.from))

  if (sent.length > 0 && received.length > 0) {
    const out = sent[0]
    const back = received[received.length - 1]
    return {
      ...base,
      type: 'swapped',
      amount: out.amount ?? '0',
      asset: assetOf(out.asset_type, out.asset_code),
      counterparty: back.from ?? 'unknown',
      destAmount: back.amount ?? '0',
      destAsset: assetOf(back.asset_type, back.asset_code),
    }
  }
  if (sent.length > 0) {
    const c = sent[0]
    return {
      ...base,
      type: 'sent',
      amount: c.amount ?? '0',
      asset: assetOf(c.asset_type, c.asset_code),
      counterparty: c.to ?? 'unknown',
    }
  }
  if (received.length > 0) {
    const c = received[0]
    return {
      ...base,
      type: 'received',
      amount: c.amount ?? '0',
      asset: assetOf(c.asset_type, c.asset_code),
      counterparty: c.from ?? 'unknown',
    }
  }
  return null
}

/**
 * Map operations to history rows.
 *
 * `mine` is every address that counts as this wallet: the spending account
 * and the wallet contract. Direction is judged against both, so a cash-out
 * paid from the contract reads as "sent" although the spending account only
 * paid the fee.
 */
export function mapOperations(operations: HorizonOperation[], mine: Iterable<string>): TxRecord[] {
  const ours = new Set([...mine].filter(Boolean))
  const rows: TxRecord[] = []

  for (const op of operations) {
    const base: Base = { id: op.id, timestamp: seconds(op.created_at), hash: op.transaction_hash }

    if (op.type === 'invoke_host_function') {
      const row = invocationToRecord(op.asset_balance_changes ?? [], ours, base)
      if (row) rows.push(row)
    } else if (op.type === 'payment') {
      const sent = !!op.from && ours.has(op.from)
      // A payment between two of our own addresses is not income or spending.
      if (sent && op.to && ours.has(op.to)) continue
      rows.push({
        ...base,
        type: sent ? 'sent' : 'received',
        amount: op.amount ?? '0',
        asset: assetOf(op.asset_type, op.asset_code),
        counterparty: (sent ? op.to : op.from) ?? 'unknown',
        memo: op.transaction?.memo,
      })
    } else if (op.type === 'create_account') {
      const sent = !!op.funder && ours.has(op.funder)
      rows.push({
        ...base,
        type: sent ? 'sent' : 'received',
        amount: op.starting_balance ?? '0',
        asset: 'XLM',
        counterparty: (sent ? op.account : op.funder) ?? 'unknown',
      })
    } else if (op.type.startsWith('path_payment')) {
      rows.push({
        ...base,
        type: 'swapped',
        amount: op.source_amount ?? op.amount ?? '0',
        asset: assetOf(op.source_asset_type, op.source_asset_code),
        counterparty: 'Stellar DEX',
        destAmount: op.amount ?? '0',
        destAsset: assetOf(op.asset_type, op.asset_code),
      })
    }
  }
  return rows
}

/** The most rows the first load keeps. */
export const HISTORY_MAX_ROWS = 100

/**
 * Join rows read from Horizon with rows read from the indexer.
 *
 * One transaction can hold several payments. A send from this wallet is two:
 * the payment itself and the Veil fee. They share a transaction hash, so the
 * hash must NOT be used to tell rows apart: doing that kept the 0.02 fee and
 * dropped the payment it belonged to. Rows are told apart by their own id.
 *
 * The indexer and Horizon can both report the same transfer, under different
 * ids. Horizon is the fuller record, so an indexer row is kept only when
 * Horizon has nothing at all for that transaction.
 */
export function mergeHistory(horizon: TxRecord[], indexer: TxRecord[]): TxRecord[] {
  const seenIds = new Set<string>()
  const horizonHashes = new Set<string>()
  const rows: TxRecord[] = []

  for (const row of horizon) {
    if (seenIds.has(row.id)) continue
    seenIds.add(row.id)
    if (row.hash) horizonHashes.add(row.hash)
    rows.push(row)
  }
  for (const row of indexer) {
    if (seenIds.has(row.id)) continue
    if (row.hash && horizonHashes.has(row.hash)) continue
    seenIds.add(row.id)
    if (row.hash) horizonHashes.add(row.hash)
    rows.push(row)
  }
  // Newest first. Rows of one transaction keep the order Horizon gave them.
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => b.row.timestamp - a.row.timestamp || a.index - b.index)
    .map(({ row }) => row)
}
