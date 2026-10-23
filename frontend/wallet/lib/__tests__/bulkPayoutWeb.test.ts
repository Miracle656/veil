import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import {
  validateRow,
  validateRows,
  parsePayoutCsv,
  resolveAsset,
  totalsByAsset,
  type WebPayoutRow,
} from '../bulkPayoutWeb'

const VALID_ADDRESS = 'GCSWM5I2FRYFIDSVJDGLWDH4TMQZY6IVT4JDF2SCFW6PPJ56TSBH23NO'
const VALID_ISSUER = 'GD2VUFNSFXBAVZEZIU6VRPFU2KMSU4VQKP65SCE4TR5C2MJPLJ6VEAIM'
const OTHER_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

function row(overrides: Partial<WebPayoutRow> = {}): WebPayoutRow {
  return {
    recipient: VALID_ADDRESS,
    amount: '10',
    assetCode: 'XLM',
    issuer: null,
    memo: '',
    ...overrides,
  }
}

describe('validateRow', () => {
  it('accepts a clean native XLM row', () => {
    expect(validateRow(row(), 1)).toEqual([])
  })

  it('accepts a clean issued-asset row pinned by issuer', () => {
    expect(validateRow(row({ assetCode: 'USDC', issuer: VALID_ISSUER }), 1)).toEqual([])
  })

  it('blocks submission on a malformed recipient address, identified by row number', () => {
    const errors = validateRow(row({ recipient: 'not-an-address' }), 3)
    expect(errors).toContainEqual(expect.objectContaining({ row: 3, field: 'recipient' }))
  })

  it('blocks submission on a bad asset — a code with no issuer is not an asset', () => {
    const errors = validateRow(row({ assetCode: 'USDT0', issuer: null }), 5)
    expect(errors).toContainEqual(expect.objectContaining({ row: 5, field: 'asset' }))
  })

  it('blocks submission when the issuer address itself is malformed', () => {
    const errors = validateRow(row({ assetCode: 'USDC', issuer: 'not-an-issuer' }), 2)
    expect(errors).toContainEqual(expect.objectContaining({ row: 2, field: 'asset' }))
  })

  it('blocks a non-positive amount', () => {
    expect(validateRow(row({ amount: '0' }), 1)).toContainEqual(
      expect.objectContaining({ field: 'amount' })
    )
    expect(validateRow(row({ amount: 'abc' }), 1)).toContainEqual(
      expect.objectContaining({ field: 'amount' })
    )
  })

  it('enforces the same 28-byte memo limit as a single send', () => {
    const overLimit = 'a'.repeat(29)
    expect(validateRow(row({ memo: overLimit }), 1)).toContainEqual(
      expect.objectContaining({ field: 'memo' })
    )
    const atLimit = 'a'.repeat(28)
    expect(validateRow(row({ memo: atLimit }), 1)).toEqual([])
  })
})

describe('validateRows', () => {
  it('reports every invalid row by number rather than stopping at the first', () => {
    const rows: WebPayoutRow[] = [
      row(),
      row({ recipient: 'bad' }),
      row({ assetCode: 'USDT0', issuer: null }),
    ]
    const errors = validateRows(rows)
    expect(errors.map(e => e.row)).toEqual([2, 3])
  })
})

describe('resolveAsset', () => {
  it('resolves distinct assets for the same code under different issuers', () => {
    const a = resolveAsset(row({ assetCode: 'USDT0', issuer: VALID_ISSUER }))
    const b = resolveAsset(row({ assetCode: 'USDT0', issuer: OTHER_ISSUER }))
    expect(a.issuer).toBe(VALID_ISSUER)
    expect(b.issuer).toBe(OTHER_ISSUER)
    expect(a.equals(b)).toBe(false)
  })

  it('resolves native XLM with no issuer', () => {
    expect(resolveAsset(row()).isNative()).toBe(true)
  })
})

describe('parsePayoutCsv', () => {
  it('parses a well-formed CSV', () => {
    const csv = `recipient,amount,asset,issuer,memo\n${VALID_ADDRESS},5,XLM,,\n${VALID_ADDRESS},10,USDC,${VALID_ISSUER},thanks`
    const { rows, errors } = parsePayoutCsv(csv)
    expect(errors).toEqual([])
    expect(rows).toHaveLength(2)
    expect(rows[1].issuer).toBe(VALID_ISSUER)
  })

  it('reports a malformed row by its row number instead of dropping it silently', () => {
    const csv = `recipient,amount,asset\nnot-an-address,5,XLM`
    const { rows, errors } = parsePayoutCsv(csv)
    expect(rows).toHaveLength(1)
    expect(errors).toContainEqual(expect.objectContaining({ row: 1, field: 'recipient' }))
  })

  it('rejects a header missing required columns', () => {
    const csv = `recipient,amount\n${VALID_ADDRESS},5`
    const { errors } = parsePayoutCsv(csv)
    expect(errors.length).toBeGreaterThan(0)
  })
})

describe('totalsByAsset', () => {
  it('sums rows per asset, keeping different issuers of the same code separate', () => {
    const rows: WebPayoutRow[] = [
      row({ amount: '10' }),
      row({ amount: '5' }),
      row({ assetCode: 'USDT0', issuer: VALID_ISSUER, amount: '20' }),
      row({ assetCode: 'USDT0', issuer: OTHER_ISSUER, amount: '30' }),
    ]
    const totals = totalsByAsset(rows)
    expect(totals['XLM']).toBe(15)
    expect(totals[`USDT0:${VALID_ISSUER}`]).toBe(20)
    expect(totals[`USDT0:${OTHER_ISSUER}`]).toBe(30)
  })
})
