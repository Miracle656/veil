import { mapOperations, type HorizonOperation } from '../walletHistory'

// Placeholders, not addresses: the mapper only compares strings, and no real
// account or wallet belongs in a test file.
const SPENDING = 'G-SPENDING-ACCOUNT'
const WALLET = 'C-WALLET-CONTRACT'
const POOL = 'C-SOME-POOL'
const BANK = 'G-SOMEONE-ELSE'
const FEES = 'G-FEE-COLLECTOR'
const MINE = [SPENDING, WALLET]

let n = 0
function op(fields: Partial<HorizonOperation>): HorizonOperation {
  n += 1
  return {
    id: String(n),
    type: 'payment',
    created_at: '2026-11-17T10:00:00Z',
    transaction_hash: `hash-${n}`,
    ...fields,
  }
}

const usdc = { asset_type: 'credit_alphanum4', asset_code: 'USDC' }

describe('the web history shows what the wallet contract did', () => {
  it('shows a cash-out paid from the wallet contract as sent', () => {
    const rows = mapOperations(
      [
        op({
          type: 'invoke_host_function',
          asset_balance_changes: [{ ...usdc, type: 'transfer', from: WALLET, to: BANK, amount: '3.4600000' }],
        }),
      ],
      MINE,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'sent', amount: '3.4600000', asset: 'USDC', counterparty: BANK })
  })

  it('shows money arriving from another contract as received', () => {
    const rows = mapOperations(
      [
        op({
          type: 'invoke_host_function',
          asset_balance_changes: [{ ...usdc, type: 'transfer', from: POOL, to: WALLET, amount: '4.7300000' }],
        }),
      ],
      MINE,
    )
    expect(rows[0]).toMatchObject({ type: 'received', amount: '4.7300000', asset: 'USDC', counterparty: POOL })
  })

  it('shows a call that spends one asset and receives another as one swap', () => {
    const rows = mapOperations(
      [
        op({
          type: 'invoke_host_function',
          asset_balance_changes: [
            { asset_type: 'native', type: 'transfer', from: WALLET, to: POOL, amount: '10.0000000' },
            { ...usdc, type: 'transfer', from: POOL, to: WALLET, amount: '1.2000000' },
          ],
        }),
      ],
      MINE,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      type: 'swapped',
      amount: '10.0000000',
      asset: 'XLM',
      destAmount: '1.2000000',
      destAsset: 'USDC',
    })
  })

  it('leaves out a contract call that moved nothing of ours', () => {
    const rows = mapOperations(
      [
        op({ type: 'invoke_host_function', asset_balance_changes: [] }),
        op({
          type: 'invoke_host_function',
          asset_balance_changes: [{ ...usdc, type: 'transfer', from: POOL, to: BANK, amount: '1.0000000' }],
        }),
      ],
      MINE,
    )
    expect(rows).toEqual([])
  })

  it('leaves out money moving between the wallet and its own spending account', () => {
    const rows = mapOperations(
      [
        op({
          type: 'invoke_host_function',
          asset_balance_changes: [{ asset_type: 'native', type: 'transfer', from: WALLET, to: SPENDING, amount: '2.0000000' }],
        }),
      ],
      MINE,
    )
    expect(rows).toEqual([])
  })
})

describe('classic operations still map as before', () => {
  it('maps a payment out and a payment in', () => {
    const rows = mapOperations(
      [
        op({ ...usdc, from: SPENDING, to: FEES, amount: '0.0200000', transaction: { memo: 'fee' } }),
        op({ ...usdc, from: BANK, to: SPENDING, amount: '19.0537997' }),
      ],
      MINE,
    )
    expect(rows[0]).toMatchObject({ type: 'sent', amount: '0.0200000', asset: 'USDC', counterparty: FEES, memo: 'fee' })
    expect(rows[1]).toMatchObject({ type: 'received', amount: '19.0537997', counterparty: BANK })
  })

  it('maps the payment that created the account', () => {
    const rows = mapOperations(
      [op({ type: 'create_account', funder: BANK, account: SPENDING, starting_balance: '5.0000000' })],
      MINE,
    )
    expect(rows[0]).toMatchObject({ type: 'received', amount: '5.0000000', asset: 'XLM', counterparty: BANK })
  })

  it('maps both kinds of path payment as a swap', () => {
    for (const type of ['path_payment_strict_send', 'path_payment_strict_receive']) {
      const rows = mapOperations(
        [
          op({
            type,
            from: SPENDING,
            to: SPENDING,
            source_amount: '10.0000000',
            source_asset_type: 'native',
            amount: '1.2000000',
            ...usdc,
          }),
        ],
        MINE,
      )
      expect(rows[0]).toMatchObject({ type: 'swapped', asset: 'XLM', destAsset: 'USDC', destAmount: '1.2000000' })
    }
  })

  it('makes no row for operations that move no money', () => {
    const rows = mapOperations([op({ type: 'manage_data' }), op({ type: 'change_trust' })], MINE)
    expect(rows).toEqual([])
  })

  it('keeps the transaction hash and the time on every row', () => {
    const rows = mapOperations([op({ ...usdc, from: SPENDING, to: FEES, amount: '1.0000000' })], MINE)
    expect(rows[0].hash).toMatch(/^hash-/)
    expect(rows[0].timestamp).toBe(Math.floor(Date.parse('2026-11-17T10:00:00Z') / 1000))
  })
})
