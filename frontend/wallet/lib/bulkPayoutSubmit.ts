/**
 * Submits validated bulk-payout rows one at a time, reporting outcome per row.
 * A failure on one row must never be silently skipped and must never stop the
 * rows after it from being attempted — the caller supplies `submitRow`, which
 * performs the actual sign-and-send for a single row (app/bulk-payout/page.tsx
 * wires this to the same fee-payer signing path as single-send).
 */
import type { WebPayoutRow, RowOutcome } from './bulkPayoutWeb'

export async function submitPayoutRows(
  rows: WebPayoutRow[],
  submitRow: (row: WebPayoutRow, rowNumber: number) => Promise<string>,
  onProgress?: (outcome: RowOutcome) => void
): Promise<RowOutcome[]> {
  const outcomes: RowOutcome[] = []
  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 1
    try {
      const txHash = await submitRow(rows[i], rowNumber)
      const outcome: RowOutcome = { row: rowNumber, status: 'success', txHash }
      outcomes.push(outcome)
      onProgress?.(outcome)
    } catch (err: unknown) {
      const outcome: RowOutcome = {
        row: rowNumber,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }
      outcomes.push(outcome)
      onProgress?.(outcome)
    }
  }
  return outcomes
}
