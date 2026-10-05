/**
 * Web-specific bulk payout row model and validation.
 *
 * sdk/src/bulkPayout.ts's PayoutRow only carries an asset code — no issuer —
 * so a row there cannot distinguish the eight different issuers who each
 * publish an asset called USDT0 on mainnet. Web pins every non-native asset by
 * issuer, so this module defines its own row shape (WebPayoutRow) with an
 * explicit issuer field, and validates each row against it: address (StrKey,
 * accepting both G-accounts and C-contracts, matching single-send), asset
 * resolved by issuer, amount, and an optional memo under the same 28-byte
 * limit as a single send. A CSV row can't express a memo type, so every memo
 * here is validated as MEMO_TEXT — see the header comment in lib/memo.ts.
 */
import { Asset, StrKey } from '@stellar/stellar-sdk'
import { validateMemoText } from './memo'

export interface WebPayoutRow {
  recipient: string
  amount: string
  assetCode: string
  /** null for native XLM. Every non-native asset must be pinned by issuer. */
  issuer: string | null
  memo: string
}

export interface RowError {
  row: number
  field: 'recipient' | 'amount' | 'asset' | 'memo'
  message: string
}

/** Validates one row. Returns [] when the row is clean. */
export function validateRow(row: WebPayoutRow, rowNumber: number): RowError[] {
  const errors: RowError[] = []

  const isValidAddress =
    StrKey.isValidEd25519PublicKey(row.recipient) || StrKey.isValidContract(row.recipient)
  if (!isValidAddress) {
    errors.push({ row: rowNumber, field: 'recipient', message: `Invalid Stellar address: ${row.recipient}` })
  }

  const amountNum = parseFloat(row.amount)
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    errors.push({ row: rowNumber, field: 'amount', message: `Invalid amount: ${row.amount}` })
  }

  if (!row.assetCode) {
    errors.push({ row: rowNumber, field: 'asset', message: 'Asset code cannot be empty' })
  } else if (row.assetCode !== 'XLM' && !row.issuer) {
    errors.push({ row: rowNumber, field: 'asset', message: `${row.assetCode} needs an issuer — a code alone is not an asset` })
  } else if (row.issuer && !StrKey.isValidEd25519PublicKey(row.issuer)) {
    errors.push({ row: rowNumber, field: 'asset', message: `Invalid issuer address: ${row.issuer}` })
  }

  const memoProblem = validateMemoText(row.memo)
  if (memoProblem) {
    errors.push({ row: rowNumber, field: 'memo', message: memoProblem })
  }

  return errors
}

export function validateRows(rows: WebPayoutRow[]): RowError[] {
  return rows.flatMap((row, i) => validateRow(row, i + 1))
}

/** Resolves the stellar-sdk Asset for a row, pinned by issuer rather than code. */
export function resolveAsset(row: WebPayoutRow): Asset {
  if (row.assetCode === 'XLM' && !row.issuer) return Asset.native()
  if (!row.issuer) throw new Error(`${row.assetCode} needs an issuer to resolve an asset`)
  return new Asset(row.assetCode, row.issuer)
}

export interface ParsedPayoutFile {
  rows: WebPayoutRow[]
  errors: RowError[]
}

/**
 * Parses a CSV with columns: recipient, amount, asset, issuer (optional for
 * XLM), memo (optional). Every parsed row is returned alongside its errors
 * (if any), numbered by CSV line — the caller decides what to do with a row
 * that failed validation rather than this function silently dropping it.
 */
export function parsePayoutCsv(csvText: string): ParsedPayoutFile {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim().length > 0)
  if (lines.length === 0) return { rows: [], errors: [] }

  const header = lines[0].split(',').map(h => h.trim().toLowerCase())
  const idx = {
    recipient: header.indexOf('recipient'),
    amount: header.indexOf('amount'),
    asset: header.indexOf('asset'),
    issuer: header.indexOf('issuer'),
    memo: header.indexOf('memo'),
  }

  const errors: RowError[] = []
  if (idx.recipient === -1 || idx.amount === -1 || idx.asset === -1) {
    errors.push({ row: 0, field: 'recipient', message: 'Missing required columns: recipient, amount, asset' })
    return { rows: [], errors }
  }

  const rows: WebPayoutRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim())
    const rowNumber = i
    const recipient = cols[idx.recipient] ?? ''
    const amount = cols[idx.amount] ?? ''
    const assetCode = (cols[idx.asset] ?? '').toUpperCase()
    const issuer = idx.issuer !== -1 ? (cols[idx.issuer]?.trim() || null) : null
    const memo = idx.memo !== -1 ? (cols[idx.memo] ?? '') : ''

    const row: WebPayoutRow = { recipient, amount, assetCode, issuer, memo }
    const rowErrors = validateRow(row, rowNumber)
    errors.push(...rowErrors)
    rows.push(row)
  }

  return { rows, errors }
}

export interface RowOutcome {
  row: number
  status: 'success' | 'failed'
  txHash?: string
  error?: string
}

/** Total per asset (keyed by code, or code:issuer for non-native), fees excluded. */
export function totalsByAsset(rows: WebPayoutRow[]): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const row of rows) {
    const key = row.assetCode === 'XLM' && !row.issuer ? 'XLM' : `${row.assetCode}:${row.issuer}`
    const amt = parseFloat(row.amount)
    if (!Number.isFinite(amt)) continue
    totals[key] = (totals[key] ?? 0) + amt
  }
  return totals
}
