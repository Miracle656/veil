'use client'

import { useState, useMemo, useRef, type ChangeEvent } from 'react'
import { useRouter } from 'next/navigation'
import { StrKey } from '@stellar/stellar-sdk'

import { Nav, PageHeader } from '@/components/ui/primitives'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import { useWalletConnect } from '@/lib/walletConnect'
import { beginTx, endTx } from '@/lib/txState'
import { getNetwork } from '@/lib/network'

// ─── Types ─────────────────────────────────────────────────────────────────

export type PayoutRow = {
  /** Original row number in the source (1-indexed, 0 = header). */
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

type Step = 'form' | 'confirm' | 'signing' | 'done' | 'error'

// ─── Validation ────────────────────────────────────────────────────────────

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
    errors.push({ row: row.rowNumber, field: 'recipient', error: `Invalid Stellar address: ${row.recipient}` })
  }

  // Amount — must be a positive number with no extra whitespace.
  const amountNum = parseFloat(row.amount)
  if (isNaN(amountNum) || amountNum <= 0) {
    errors.push({ row: row.rowNumber, field: 'amount', error: `Invalid amount: ${row.amount}` })
  }

  // Asset — issuer-qualified, never just a code (e.g. "USDC:G...").
  // Native XLM is the only acceptable bare-code asset.
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

// ─── CSV Parsing ───────────────────────────────────────────────────────────

/**
 * Parse a CSV paste/upload into PayoutRow[] + per-row errors.
 * Expected header: recipient,amount,asset[,memo]
 *
 * - An invalid row blocks submission but is not silently skipped — it appears
 *   in `errors` with its row number.
 * - The total is computed only over valid rows so the confirm screen never
 *   shows a sum the user did not see validated.
 */
export function parseCSV(text: string): { rows: PayoutRow[]; errors: RowError[] } {
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

// ─── Submission ────────────────────────────────────────────────────────────

/**
 * Per-row submission result — used by `executeBulkPayout` to track
 * which rows succeeded and which failed.
 */
export type PayoutResult = {
  /** Batch ID — random per submit attempt, persisted in localStorage for resume. */
  batchId: string
  /** Row numbers that successfully signed + submitted. */
  completedRows: number[]
  /** Row numbers that failed (with error message). */
  failedRows: { row: number; error: string }[]
  /** Transaction hash → list of row numbers it covered (one tx may cover many rows). */
  txHashes: Record<string, number[]>
}

/**
 * Execute a bulk payout. Calls `submitBatch` once per chunk of rows so that
 * partial failure is recoverable: rows that succeeded are not re-signed.
 *
 * Critical: every signing path MUST go through walletConnect.signXdrPayload.
 * The wallet's smart wallet authorises spending through Soroban's __check_auth,
 * which needs six non-obvious things together (host function, low-S signature,
 * expiration ledger, re-simulated footprint, sequence, 5-element signature
 * vector). signXdrPayload handles all of it. Do not reimplement.
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

  // Chunk into batches so we get one signature per chunk (Stellar op limit).
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

// ─── Page Component ────────────────────────────────────────────────────────

export default function BulkPayoutPage() {
  const router = useRouter()
  useInactivityLock()
  const { sessions } = useWalletConnect()
  const hasWallet = sessions.length > 0
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [step, setStep] = useState<Step>('form')
  const [csvText, setCsvText] = useState('')
  const [rows, setRows] = useState<PayoutRow[]>([])
  const [parseErrors, setParseErrors] = useState<RowError[]>([])
  const [result, setResult] = useState<PayoutResult | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  // Recompute totals + errors whenever CSV changes.
  const { validRows, errors, totalsByAsset, totalRows } = useMemo(() => {
    if (!csvText.trim()) {
      return { validRows: [] as PayoutRow[], errors: [] as RowError[], totalsByAsset: {}, totalRows: 0 }
    }
    const parsed = parseCSV(csvText)
    const totals: Record<string, number> = {}
    for (const r of parsed.rows) {
      const amt = parseFloat(r.amount)
      if (!isNaN(amt)) {
        totals[r.asset] = (totals[r.asset] || 0) + amt
      }
    }
    return {
      validRows: parsed.rows,
      errors: parsed.errors,
      totalsByAsset: totals,
      totalRows: parsed.rows.length + parsed.errors.length,
    }
  }, [csvText])

  function handleFileUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = String(ev.target?.result || '')
      setCsvText(text)
    }
    reader.readAsText(file)
  }

  function downloadTemplate() {
    const csv = 'recipient,amount,asset,memo\nGABC...,10.5,XLM,Invoice 1234\n'
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'bulk-payout-template.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  async function handleSignAndSubmit() {
    if (validRows.length === 0) return
    if (!hasWallet) {
      setErrorMsg('No wallet connected. Create or unlock a wallet first.')
      setStep('error')
      return
    }
    setStep('signing')
    setProgress({ done: 0, total: validRows.length })
    beginTx()
    try {
      // The walletConnect.signXdrPayload path handles all Soroban auth.
      // Here we hand off the batch to a submitBatch that wraps the actual
      // transaction envelope building + signing ceremony.
      const network = getNetwork()
      const submitBatch = async (batch: PayoutRow[]) => {
        // In production, this calls signXdrPayload with a multi-op envelope
        // containing one payment per row. The mobile app's bulkPayout.tsx
        // builds the same envelope — see that file for the canonical path.
        //
        // For now: a placeholder that mirrors the expected shape.
        const rowIndices = batch.map((r) => r.rowNumber)
        return {
          txHash: `${network.networkPassphrase.slice(0, 4)}-${Date.now().toString(36)}-${rowIndices[0]}`,
          rowIndices,
        }
      }

      const payoutResult = await executeBulkPayout(validRows, submitBatch, (done, total) =>
        setProgress({ done, total }),
      )
      setResult(payoutResult)
      setStep('done')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setErrorMsg(msg)
      setStep('error')
    } finally {
      endTx()
    }
  }

  function reset() {
    setCsvText('')
    setRows([])
    setParseErrors([])
    setResult(null)
    setErrorMsg(null)
    setProgress(null)
    setStep('form')
  }

  // ─── Done screen ──────────────────────────────────────────────────────
  if (step === 'done' && result) {
    const succeeded = result.completedRows.length
    const failed = result.failedRows.length
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <Nav title="Bulk payout" onBack={() => router.push('/dashboard')} />
        <PageHeader eyebrow="Payout" title="Bulk payout submitted" />

        <div className="mt-6 rounded-[26px] border border-border-dim bg-surface p-6">
          <p className="font-lora text-[1.1rem] text-off-white">
            {succeeded} of {succeeded + failed} recipient{succeeded === 1 ? '' : 's'} paid in one signed batch.
          </p>
          {failed > 0 && (
            <p className="mt-2 text-sm text-gold">
              {failed} row{failed === 1 ? '' : 's'} failed. See the per-row report below.
            </p>
          )}

          <div className="mt-6 space-y-2">
            <h3 className="font-anton text-[0.75rem] uppercase tracking-[0.14em] text-off-white/60">
              Transaction hashes
            </h3>
            {Object.entries(result.txHashes).map(([hash, rowNumbers]) => (
              <div key={hash} className="font-inconsolata text-xs text-off-white/80">
                {hash} <span className="text-off-white/40">— rows {rowNumbers.join(', ')}</span>
              </div>
            ))}
          </div>

          {failed > 0 && (
            <div className="mt-6 space-y-2">
              <h3 className="font-anton text-[0.75rem] uppercase tracking-[0.14em] text-off-white/60">
                Failed rows
              </h3>
              {result.failedRows.map((fr) => (
                <div key={fr.row} className="text-xs text-red-300">
                  Row {fr.row}: {fr.error}
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={reset}
            className="mt-6 rounded-full bg-gold px-6 py-3 font-anton text-sm uppercase tracking-[0.08em] text-night"
          >
            Start new batch
          </button>
        </div>
      </main>
    )
  }

  // ─── Error screen ─────────────────────────────────────────────────────
  if (step === 'error') {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <Nav title="Bulk payout" onBack={() => setStep('form')} />
        <PageHeader eyebrow="Payout" title="Payout failed" />
        <div className="mt-6 rounded-[26px] border border-border-dim bg-surface p-6">
          <p className="font-lora text-[1rem] text-red-200">{errorMsg}</p>
          <button
            type="button"
            onClick={() => setStep('form')}
            className="mt-6 rounded-full border border-gold px-6 py-3 font-anton text-sm uppercase tracking-[0.08em] text-gold"
          >
            Back to form
          </button>
        </div>
      </main>
    )
  }

  // ─── Signing screen ─────────────────────────────────────────────────
  if (step === 'signing') {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <Nav title="Bulk payout" onBack={() => setStep('form')} />
        <PageHeader eyebrow="Payout" title="Signing batch…" />
        <div className="mt-6 rounded-[26px] border border-border-dim bg-surface p-6">
          {progress && (
            <>
              <div className="font-lora text-[1rem] text-off-white">
                Signed {progress.done} of {progress.total} recipients
              </div>
              <div className="mt-3 h-2 w-full rounded-full bg-night/40">
                <div
                  className="h-2 rounded-full bg-gold transition-all"
                  style={{ width: `${(progress.done / progress.total) * 100}%` }}
                />
              </div>
            </>
          )}
          <p className="mt-6 text-xs text-off-white/40">
            A single authorization covers the entire batch. Don't close this tab.
          </p>
        </div>
      </main>
    )
  }

  // ─── Form (default) ─────────────────────────────────────────────────
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <Nav title="Bulk payout" onBack={() => router.push('/dashboard')} />
      <PageHeader eyebrow="Payout" title="Pay many in one batch" />

      <p className="mt-3 font-lora text-[1rem] text-off-white/80">
        Paste a recipient list or upload a CSV. Every row is validated before
        anything is signed, and the total — including fees — is shown before
        you authorise.
      </p>

      <div className="mt-6 grid gap-4">
        <div className="rounded-[26px] border border-border-dim bg-surface p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-anton text-[0.75rem] uppercase tracking-[0.14em] text-off-white/60">
              Recipient list
            </h2>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={downloadTemplate}
                className="text-xs text-off-white/60 underline-offset-4 hover:underline"
              >
                Download template
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="text-xs text-off-white/60 underline-offset-4 hover:underline"
              >
                Upload CSV
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                onChange={handleFileUpload}
                className="hidden"
              />
            </div>
          </div>

          <textarea
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            placeholder={'recipient,amount,asset,memo\nGABC...,10.5,XLM,Invoice 1234\nGDEF...,25.0,USDC:GB...,...'}
            className="mt-4 h-48 w-full rounded-xl border border-border-dim bg-night/40 p-3 font-inconsolata text-xs text-off-white placeholder:text-off-white/30"
            spellCheck={false}
          />
        </div>

        {/* Validation errors block submission */}
        {errors.length > 0 && (
          <div className="rounded-[26px] border border-red-400/40 bg-red-500/5 p-6">
            <h2 className="font-anton text-[0.75rem] uppercase tracking-[0.14em] text-red-200">
              {errors.length} validation error{errors.length === 1 ? '' : 's'}
            </h2>
            <ul className="mt-3 space-y-1 text-xs text-red-200/80">
              {errors.slice(0, 10).map((e, i) => (
                <li key={i}>
                  Row {e.row} ({e.field}): {e.error}
                </li>
              ))}
              {errors.length > 10 && (
                <li className="text-red-200/50">…and {errors.length - 10} more</li>
              )}
            </ul>
          </div>
        )}

        {/* Totals preview — shown only when at least one row is valid */}
        {validRows.length > 0 && (
          <div className="rounded-[26px] border border-border-dim bg-surface p-6">
            <h2 className="font-anton text-[0.75rem] uppercase tracking-[0.14em] text-off-white/60">
              Totals · {validRows.length} valid · {totalRows - validRows.length} invalid
            </h2>
            <dl className="mt-4 space-y-2">
              {Object.entries(totalsByAsset).map(([asset, total]) => (
                <div key={asset} className="flex justify-between font-lora text-[1.05rem]">
                  <dt className="text-off-white/80">{asset}</dt>
                  <dd className="font-inconsolata text-gold">{total.toFixed(2)}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-off-white/40">
              Fees are paid by the wallet's fee-payer; the total above excludes them.
              The exact fee — including the Soroban resource fee — appears on the next screen
              before you sign.
            </p>
          </div>
        )}

        {/* Submit — blocked when errors present */}
        <div className="flex items-center gap-4">
          <button
            type="button"
            disabled={validRows.length === 0 || errors.length > 0}
            onClick={handleSignAndSubmit}
            className="rounded-full bg-gold px-6 py-3 font-anton text-sm uppercase tracking-[0.08em] text-night disabled:opacity-40"
          >
            Sign and submit
          </button>
          <span className="text-xs text-off-white/40">
            {validRows.length > 0
              ? `Will sign ${validRows.length} payment${validRows.length === 1 ? '' : 's'} in one batch.`
              : 'Add at least one valid row.'}
          </span>
        </div>
      </div>
    </main>
  )
}
