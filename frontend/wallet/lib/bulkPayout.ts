/**
 * Bulk payout utilities — pure functions, no React, no wallet imports.
 *
 * Validation rules (per issue #835):
 *   - Per-row validation: address, asset by issuer, amount, optional memo
 *   - An invalid row blocks submission and is identified by row number
 *   - Assets resolve by issuer, never by code (XLM is the only exception)
 *   - Memo byte limit is the same as a single send: 28 bytes
 *   - Partial failure is reported per row; a failed row must never be
 *     silently skipped.
 */

import { StrKey } from '@stellar/stellar-sdk'

export type PayoutRow = {
  /** Original row number in the source (1-indexed; matches CSV file line numbers). */
  rowNumber: number
  recipient: string
  amount: string
  asset: string
  /** Optional memo. Stellar memos are limited to 28 bytes. */
  memo?: string
}

export type RowError = {
  row: number
  field: 'recipient' | 'amount' | 'asset' | 'memo'
  error: string
}

/** Parse result — valid rows + per-row errors. Invalid rows are never silently skipped. */
export type ParseResult = {
  rows: PayoutRow[]
  errors: RowError[]
}

const MEMO_MAX_BYTES = 28

/** Memo byte-length guard — Stellar's hard cap. */
function memoByteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

/** Validate a single row. Returns an array of errors (empty = valid). */
export function validateRow(row: PayoutRow): RowError[] {
  const errors: RowError[] = []

  // Recipient — must be a valid Stellar public key (G...).
  if (!row.recipient) {
    errors.push({ row: row.rowNumber, field: 'recipient', error: 'Recipient is required' })
  } else if (!StrKey.isValidEd25519PublicKey(row.recipient)) {
    errors.push({
      row: row.rowNumber,
      field: 'recipient',
      error: `Invalid Stellar address: ${row.recipient}`,
    })
  }

  // Amount — must be a positive number with no extra whitespace.
  const amountNum = parseFloat(row.amount)
  if (isNaN(amountNum) || amountNum <= 0) {
    errors.push({ row: row.rowNumber, field: 'amount', error: `Invalid amount: ${row.amount}` })
  }

  // Asset — issuer-qualified, never just a code (XLM is the only bare-code exception).
  if (!row.asset) {
    errors.push({ row: row.rowNumber, field: 'asset', error: 'Asset is required' })
  } else if (row.asset !== 'XLM' && !row.asset.includes(':')) {
    errors.push({
      row: row.rowNumber,
      field: 'asset',
      error: `Asset must be qualified by issuer (e.g. "USDC:G..."). Got: ${row.asset}`,
    })
  }

  // Memo — at most 28 bytes.
  if (row.memo && memoByteLength(row.memo) > MEMO_MAX_BYTES) {
    errors.push({
      row: row.rowNumber,
      field: 'memo',
      error: `Memo exceeds ${MEMO_MAX_BYTES} bytes (was ${memoByteLength(row.memo)} bytes)`,
    })
  }

  return errors
}

/**
 * Parse a CSV paste/upload into PayoutRow[] + per-row errors.
 * Expected header: recipient,amount,asset[,memo]
 *
 * - An invalid row blocks submission but is not silently skipped — it appears
 *   in `errors` with its row number.
 * - The total is computed only over valid rows so the confirm screen never
 *   shows a sum the user did not see validated.
 */
export function parseCSV(text: string): ParseResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  const errors: RowError[] = []
  const rows: PayoutRow[] = []

  if (lines.length === 0) {
    return { rows, errors: [{ row: 0, field: 'recipient', error: 'No rows found' }] }
  }

  // Detect + parse header. If no header, assume order: recipient,amount,asset.
  const headerCols = lines[0].split(',').map((c) => c.trim().toLowerCase())
  const hasHeader = headerCols.some((h) => ['recipient', 'amount', 'asset', 'memo'].includes(h))

  let recipientIdx = 0
  let amountIdx = 1
  let assetIdx = 2
  let memoIdx = -1

  if (hasHeader) {
    recipientIdx = headerCols.indexOf('recipient')
    amountIdx = headerCols.indexOf('amount')
    assetIdx = headerCols.indexOf('asset')
    memoIdx = headerCols.indexOf('memo')

    if (recipientIdx === -1 || amountIdx === -1 || assetIdx === -1) {
      return {
        rows,
        errors: [
          { row: 0, field: 'recipient', error: 'Missing required columns: recipient, amount, asset' },
        ],
      }
    }
  }

  const startLine = hasHeader ? 1 : 0
  for (let i = startLine; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i])
    const rowNumber = i + 1 // 1-indexed matches CSV file line numbers
    const row: PayoutRow = {
      rowNumber,
      recipient: (cols[recipientIdx] ?? '').trim(),
      amount: (cols[amountIdx] ?? '').trim(),
      asset: (cols[assetIdx] ?? '').trim(),
      memo: memoIdx >= 0 ? (cols[memoIdx] ?? '').trim() : undefined,
    }

    const rowErrors = validateRow(row)
    if (rowErrors.length > 0) {
      errors.push(...rowErrors)
    } else {
      rows.push(row)
    }
  }

  return { rows, errors }
}

/** Parse a CSV line — handles quoted fields with embedded commas. */
function parseCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"' && line[i + 1] === '"') {
      current += '"'
      i++
    } else if (ch === '"') {
      inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      result.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  result.push(current)
  return result
}

/** Aggregate valid rows by asset — used for the totals preview. */
export function computeTotals(rows: PayoutRow[]): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const r of rows) {
    const amt = parseFloat(r.amount)
    if (!isNaN(amt)) {
      totals[r.asset] = (totals[r.asset] || 0) + amt
    }
  }
  return totals
}

export type PayoutResult = {
  /** Batch ID — random per submit attempt. */
  batchId: string
  /** Row numbers that successfully signed + submitted. */
  completedRows: number[]
  /** Row numbers that failed (with error message). */
  failedRows: { row: number; error: string }[]
  /** Transaction hash → list of row numbers it covered. */
  txHashes: Record<string, number[]>
}

/**
 * Execute a bulk payout. Calls `submitBatch` once per chunk so partial failure
 * is recoverable: rows that succeeded are not re-signed.
 *
 * The caller MUST route signing through walletConnect.signXdrPayload — see
 * the issue body for the canonical signing ceremony.
 */
export async function executeBulkPayout(
  rows: PayoutRow[],
  submitBatch: (batch: PayoutRow[]) => Promise<{ txHash: string; rowIndices: number[] }>,
  onProgress?: (completed: number, total: number) => void,
  batchSize = 10,
): Promise<PayoutResult> {
  const batchId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Date.now().toString(36)

  const result: PayoutResult = {
    batchId,
    completedRows: [],
    failedRows: [],
    txHashes: {},
  }

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize)
    const indices = batch.map((r) => r.rowNumber)
    try {
      const { txHash, rowIndices } = await submitBatch(batch)
      result.completedRows.push(...rowIndices)
      result.txHashes[txHash] = rowIndices
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      for (const idx of indices) {
        result.failedRows.push({ row: idx, error: msg })
      }
    }
    onProgress?.(Math.min(i + batchSize, rows.length), rows.length)
  }

  return result
}
