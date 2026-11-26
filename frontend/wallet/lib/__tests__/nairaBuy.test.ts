import { parseSwapPrefill } from '../../app/swap/direction'
import { DELIVERED_COIN, convertPath, convertibleXlm, parseBuyWant, onrampStage } from '../nairaBuy'

describe('buying USDC with naira', () => {
  it('always orders XLM, the only coin the naira service delivers', () => {
    expect(DELIVERED_COIN).toBe('xlm')
  })

  it('reads a stored choice, falling back to USDC', () => {
    expect(parseBuyWant('xlm')).toBe('xlm')
    expect(parseBuyWant('usdc')).toBe('usdc')
    expect(parseBuyWant(null)).toBe('usdc')
    expect(parseBuyWant('btc')).toBe('usdc')
  })

  it('keeps 2 XLM back when converting', () => {
    expect(convertibleXlm(25.3337914)).toBe('23.33')
    expect(convertibleXlm(2)).toBeNull()
    expect(convertibleXlm(1.2)).toBeNull()
    expect(convertibleXlm(NaN)).toBeNull()
  })

  it('opens Swap on XLM to USDC with the amount the Swap screen can read', () => {
    const path = convertPath(25.3337914)
    const prefill = parseSwapPrefill(path.slice(path.indexOf('?')))
    expect(prefill.from).toBe('XLM')
    expect(prefill.to).toBe('USDC')
    expect(prefill.amount).toBe('23.33')
  })

  it('names no amount when too little arrived to convert', () => {
    expect(convertPath(1.5)).toBe('/swap?from=XLM&to=USDC')
  })
})

describe('onrampStage', () => {
  it('waits until the service says otherwise', () => {
    expect(onrampStage('pending', 600)).toBe('waiting')
    expect(onrampStage('initiated', 600)).toBe('waiting')
    expect(onrampStage('', 600)).toBe('waiting')
    expect(onrampStage('something_new', 600)).toBe('waiting')
  })

  it('says the naira is in once the service is working on the payout', () => {
    expect(onrampStage('processing', 600)).toBe('received')
    expect(onrampStage('payment_received', 600)).toBe('received')
    // Still received after the account's window has closed: the money is in.
    expect(onrampStage('processing', 0)).toBe('received')
  })

  it('reads an ending by whole words', () => {
    expect(onrampStage('completed', 600)).toBe('done')
    expect(onrampStage('SUCCESS', 600)).toBe('done')
    expect(onrampStage('settled', 0)).toBe('done')
    expect(onrampStage('failed', 600)).toBe('failed')
    expect(onrampStage('refunded', 600)).toBe('failed')
  })

  it('does not take a piece of a word, or a status still moving, for an ending', () => {
    expect(onrampStage('unpaid', 600)).toBe('waiting')
    expect(onrampStage('incomplete', 600)).toBe('waiting')
    expect(onrampStage('refund_pending', 600)).toBe('waiting')
    expect(onrampStage('pending_completion', 600)).toBe('waiting')
    expect(onrampStage('unsuccessful', 600)).toBe('waiting')
  })

  it('is expired only when nothing arrived before the window closed', () => {
    expect(onrampStage('pending', 0)).toBe('expired')
    expect(onrampStage('pending', -5)).toBe('expired')
  })
})
