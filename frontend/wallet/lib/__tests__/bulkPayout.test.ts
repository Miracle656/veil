import { describe, it, expect } from 'vitest'
import { parseCSV, validateRow, type PayoutRow, type RowError } from '../bulkPayout'

// Real valid Stellar public keys (from veil codebase)
const ADDR_A = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const ADDR_B = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const ADDR_C = 'GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6'

describe('parseCSV', () => {
  it('parses a valid CSV with header', () => {
    const csv = 'recipient,amount,asset,memo\n' + `${ADDR_A},10.5,XLM,Invoice 1\n` + `${ADDR_B},25.0,USDC:GB...,Invoice 2`
    const { rows, errors } = parseCSV(csv)
    expect(errors).toHaveLength(0)
    expect(rows).toHaveLength(2)
    expect(rows[0].recipient).toBe(ADDR_A)
    expect(rows[0].amount).toBe('10.5')
    expect(rows[0].asset).toBe('XLM')
    expect(rows[0].memo).toBe('Invoice 1')
  })

  it('parses CSV without header (assumes recipient,amount,asset)', () => {
    const csv = `${ADDR_A},10.5,XLM\n${ADDR_B},25.0,USDC:GB...`
    const { rows, errors } = parseCSV(csv)
    expect(errors).toHaveLength(0)
    expect(rows).toHaveLength(2)
  })

  it('rejects malformed recipient and reports row number', () => {
    const csv = 'recipient,amount,asset\nNOT_AN_ADDRESS,10.5,XLM'
    const { rows, errors } = parseCSV(csv)
    expect(rows).toHaveLength(0)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].row).toBe(2) // line number in file (header is line 1)
    expect(errors[0].field).toBe('recipient')
  })

  it('rejects zero or negative amount', () => {
    const csv = `recipient,amount,asset\n${ADDR_A},0,XLM\n${ADDR_B},-5,XLM`
    const { rows, errors } = parseCSV(csv)
    expect(rows).toHaveLength(0)
    expect(errors).toHaveLength(2)
    expect(errors.every((e: RowError) => e.field === 'amount')).toBe(true)
  })

  it('rejects unqualified asset code', () => {
    const csv = `recipient,amount,asset\n${ADDR_A},10.5,USDC`
    const { rows, errors } = parseCSV(csv)
    expect(rows).toHaveLength(0)
    expect(errors[0].field).toBe('asset')
    expect(errors[0].error).toContain('qualified by issuer')
  })

  it('accepts XLM as bare code', () => {
    const csv = `recipient,amount,asset\n${ADDR_A},10.5,XLM`
    const { rows, errors } = parseCSV(csv)
    expect(rows).toHaveLength(1)
    expect(errors).toHaveLength(0)
  })

  it('rejects memo over 28 bytes', () => {
    const longMemo = 'a'.repeat(29)
    const csv = `recipient,amount,asset,memo\n${ADDR_A},10.5,XLM,${longMemo}`
    const { rows, errors } = parseCSV(csv)
    expect(rows).toHaveLength(0)
    expect(errors[0].field).toBe('memo')
    expect(errors[0].error).toContain('exceeds 28 bytes')
  })

  it('rejects missing required columns', () => {
    const csv = `recipient,amount\n${ADDR_A},10.5`
    const { rows, errors } = parseCSV(csv)
    expect(rows).toHaveLength(0)
    expect(errors[0].error).toContain('Missing required columns')
  })

  it('handles quoted CSV fields with embedded commas', () => {
    const csv = `recipient,amount,asset,memo\n${ADDR_A},10.5,XLM,"Invoice, with comma"`
    const { rows, errors } = parseCSV(csv)
    expect(errors).toHaveLength(0)
    expect(rows).toHaveLength(1)
    expect(rows[0].memo).toBe('Invoice, with comma')
  })

  it('multiple errors reported per row when present', () => {
    const csv = 'recipient,amount,asset\nNOT_AN_ADDRESS,0,USDC'
    const { rows, errors } = parseCSV(csv)
    expect(rows).toHaveLength(0)
    // 3 errors: recipient invalid, amount invalid, asset unqualified
    expect(errors.length).toBe(3)
  })

  it('skips empty lines silently', () => {
    const csv = `recipient,amount,asset\n${ADDR_A},10.5,XLM\n\n${ADDR_B},5,XLM`
    const { rows, errors } = parseCSV(csv)
    expect(rows).toHaveLength(2)
    expect(errors).toHaveLength(0)
  })

  it('reports correct row number after skipping header', () => {
    const csv = `recipient,amount,asset\n${ADDR_A},10.5,XLM\nINVALID,5,XLM\n${ADDR_B},3,XLM`
    const { rows, errors } = parseCSV(csv)
    expect(rows).toHaveLength(2) // rows 1 and 3
    expect(errors).toHaveLength(1)
    expect(errors[0].row).toBe(3) // 1-indexed line number in file
  })

  it('partial failure reports per-row txHashes + failed row numbers', async () => {
    const rows: PayoutRow[] = [
      { rowNumber: 1, recipient: ADDR_A, amount: '10', asset: 'XLM' },
      { rowNumber: 2, recipient: ADDR_B, amount: '20', asset: 'XLM' },
      { rowNumber: 3, recipient: ADDR_C, amount: '30', asset: 'XLM' },
    ]

    // Mock submitBatch — succeeds for first batch (rows 1,2), fails for second (row 3).
    let callCount = 0
    const submitBatch = async (batch: PayoutRow[]) => {
      callCount++
      if (callCount === 1) {
        return { txHash: 'hash1', rowIndices: batch.map((r) => r.rowNumber) }
      }
      throw new Error('Network error')
    }

    const result = await executeBulkPayoutForTest(rows, submitBatch, undefined, 2)
    expect(result.completedRows).toContain(1)
    expect(result.completedRows).toContain(2)
    expect(result.failedRows).toHaveLength(1)
    expect(result.failedRows[0].row).toBe(3)
    expect(result.failedRows[0].error).toBe('Network error')
  })
})

// Local import to avoid circular deps with page.tsx
import { executeBulkPayout as executeBulkPayoutForTest } from '../bulkPayout'

describe('validateRow', () => {
  it('accepts a fully valid row', () => {
    const row: PayoutRow = { rowNumber: 1, recipient: ADDR_A, amount: '10.5', asset: 'XLM' }
    expect(validateRow(row)).toHaveLength(0)
  })

  it('returns all errors for a completely invalid row', () => {
    const row: PayoutRow = { rowNumber: 1, recipient: '', amount: '', asset: '' }
    const errors = validateRow(row)
    expect(errors.length).toBeGreaterThanOrEqual(3)
  })

  it('accepts unicode memo within byte limit', () => {
    // Greek letters are 2 bytes each in UTF-8. 14 chars × 2 = 28 bytes.
    const memo = 'α'.repeat(14)
    const row: PayoutRow = { rowNumber: 1, recipient: ADDR_A, amount: '10.5', asset: 'XLM', memo }
    expect(validateRow(row)).toHaveLength(0)
  })

  it('rejects unicode memo exceeding byte limit', () => {
    const memo = 'α'.repeat(15) // 15 × 2 = 30 bytes > 28
    const row: PayoutRow = { rowNumber: 1, recipient: ADDR_A, amount: '10.5', asset: 'XLM', memo }
    const errors = validateRow(row)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].field).toBe('memo')
  })
})
