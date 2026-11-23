import { parseSwapPrefill } from '../../app/swap/direction'
import { DELIVERED_COIN, convertPath, convertibleXlm, parseBuyWant } from '../nairaBuy'

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
