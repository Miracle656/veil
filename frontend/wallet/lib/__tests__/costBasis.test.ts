import { compareCostBasis, type RecordedCostBasis } from '../costBasis'

const basis: RecordedCostBasis = { amount: '100', costUsdc: '100', recordedAt: 1 }

describe('compareCostBasis', () => {
  it('reports an absolute increase from a recorded USDC basis', () => {
    const result = compareCostBasis('100.0000000', 107.6, basis)
    expect(result.status).toBe('known')
    if (result.status === 'known') {
      expect(result.costUsdc).toBe(100)
      expect(result.changeUsdc).toBeCloseTo(7.6, 10)
    }
  })

  it('reports a price fall as a negative absolute change', () => {
    const result = compareCostBasis('100', 92, basis)
    expect(result).toEqual({ status: 'known', costUsdc: 100, changeUsdc: -8 })
  })

  it('keeps the change unknown when no cost was recorded', () => {
    expect(compareCostBasis('100', 107.6, null)).toEqual({ status: 'unknown', reason: 'not-recorded' })
  })

  it('does not apply a recorded basis after the holding amount changes', () => {
    expect(compareCostBasis('80', 86.08, basis)).toEqual({ status: 'unknown', reason: 'holding-changed' })
  })
})
