import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { createElement } from 'react'
import * as React from 'react'
Object.assign(globalThis, { React })
import { renderToStaticMarkup } from 'react-dom/server'

import { TxDetailSheet, type TxRecord } from '../TxDetailSheet'
import { rememberDepositAddress } from '../../lib/cashOutAddresses'

describe('TxDetailSheet', () => {
  const WALLET = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  const DEP_ADDR = 'GDEPOSIT111111111111111111111111111111111111111111111111'
  const STRANGER = 'GSTRANGER11111111111111111111111111111111111111111111111'

  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    sessionStorage.setItem('invisible_wallet_address', WALLET)
  })

  afterEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  function render(tx: TxRecord, knownDepositAddresses?: string[]): string {
    return renderToStaticMarkup(
      createElement(TxDetailSheet, {
        tx,
        onClose: () => {},
        knownDepositAddresses,
      }),
    )
  }

  const makeTx = (type: TxRecord['type'], counterparty: string): TxRecord => ({
    id: 'tx-1',
    type,
    amount: '50',
    asset: 'USDC',
    counterparty,
    timestamp: 1_700_000_000,
    hash: 'deadbeef1234567890abcdef1234567890abcdef',
  })

  it('renders Type as "Cashed out" when sent to a remembered deposit address', () => {
    rememberDepositAddress(DEP_ADDR, WALLET, 'testnet')
    const html = render(makeTx('sent', DEP_ADDR))
    expect(html).toContain('Cashed out')
    expect(html).not.toContain('>Sent<')
  })

  it('renders Type as "Cashed out" when knownDepositAddresses prop contains the counterparty', () => {
    const html = render(makeTx('sent', DEP_ADDR), [DEP_ADDR])
    expect(html).toContain('Cashed out')
  })

  it('renders Type as "Sent" for a standard send to an unknown address', () => {
    rememberDepositAddress(DEP_ADDR, WALLET, 'testnet')
    const html = render(makeTx('sent', STRANGER))
    expect(html).toContain('Sent')
    expect(html).not.toContain('Cashed out')
  })

  it('renders Type as "Received" for receipts even if counterparty is in deposit addresses', () => {
    rememberDepositAddress(DEP_ADDR, WALLET, 'testnet')
    const html = render(makeTx('received', DEP_ADDR))
    expect(html).toContain('Received')
    expect(html).not.toContain('Cashed out')
  })

  it('renders Type as "Swap" for swaps', () => {
    const swapTx: TxRecord = {
      id: 'tx-swap',
      type: 'swapped',
      amount: '10',
      asset: 'XLM',
      destAmount: '12',
      destAsset: 'USDC',
      counterparty: 'Stellar DEX',
      timestamp: 1_700_000_000,
    }
    const html = render(swapTx)
    expect(html).toContain('Swap')
  })
})
