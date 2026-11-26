import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { submitPayoutRows } from '../bulkPayoutSubmit'
import type { WebPayoutRow } from '../bulkPayoutWeb'

const VALID_ADDRESS = 'GCSWM5I2FRYFIDSVJDGLWDH4TMQZY6IVT4JDF2SCFW6PPJ56TSBH23NO'

function row(amount: string): WebPayoutRow {
  return { recipient: VALID_ADDRESS, amount, assetCode: 'XLM', issuer: null, memo: '' }
}

describe('submitPayoutRows', () => {
  it('reports exactly which rows succeeded and which failed on a partial failure', async () => {
    const rows = [row('1'), row('2'), row('3')]
    const outcomes = await submitPayoutRows(rows, async (r, rowNumber) => {
      if (rowNumber === 2) throw new Error('insufficient balance')
      return `tx-${rowNumber}`
    })

    expect(outcomes).toEqual([
      { row: 1, status: 'success', txHash: 'tx-1' },
      { row: 2, status: 'failed', error: 'insufficient balance' },
      { row: 3, status: 'success', txHash: 'tx-3' },
    ])
  })

  it('never silently skips a failed row', async () => {
    const rows = [row('1'), row('2')]
    const outcomes = await submitPayoutRows(rows, async () => {
      throw new Error('network error')
    })
    expect(outcomes).toHaveLength(rows.length)
    expect(outcomes.every(o => o.status === 'failed')).toBe(true)
  })

  it('continues submitting rows after an earlier one fails', async () => {
    const rows = [row('1'), row('2'), row('3')]
    const attempted: number[] = []
    await submitPayoutRows(rows, async (r, rowNumber) => {
      attempted.push(rowNumber)
      if (rowNumber === 1) throw new Error('bad row')
      return `tx-${rowNumber}`
    })
    expect(attempted).toEqual([1, 2, 3])
  })
})
