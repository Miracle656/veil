import {
  formatAbsoluteTimestamp,
  positionValueDrop,
  queueMaturityTimestamp,
  VAULT_COPY,
} from '../vaultPresentation'

describe('vault queue presentation', () => {
  it('derives an absolute maturity timestamp from the queue timestamp and contract delay', () => {
    expect(queueMaturityTimestamp(1_700_000_000, 17 * 86_400))
      .toBe(1_700_000_000 + 17 * 86_400)
  })

  it('rejects invalid queue timestamps and delays', () => {
    expect(() => queueMaturityTimestamp(-1, 86_400)).toThrow()
    expect(() => queueMaturityTimestamp(1_700_000_000, 0)).toThrow()
  })

  it('formats a maturity date with an explicit timezone', () => {
    const formatted = formatAbsoluteTimestamp(
      1_700_000_000,
      'en-US',
      'UTC',
    )
    expect(formatted).toContain('2023')
    expect(formatted).toMatch(/UTC|Coordinated Universal Time/)
  })

  it('states emissions and pool interest as separate queued-position effects', () => {
    expect(VAULT_COPY.emissionsQueued).toContain('Emissions stop')
    expect(VAULT_COPY.interestQueued).toContain('interest continues')
  })

  it('marks a share-value fall with amount and percentage', () => {
    const drop = positionValueDrop(
      { timestamp: 1_700_000_000, valueStroops: 100_000_000n },
      { timestamp: 1_700_086_400, valueStroops: 90_000_000n },
    )
    expect(drop).toEqual({
      previousStroops: 100_000_000n,
      currentStroops: 90_000_000n,
      amountXlm: '1',
      percentage: 10,
    })
  })

  it('does not mark a gain or unchanged value as a drop', () => {
    expect(positionValueDrop(
      { timestamp: 1, valueStroops: 100n },
      { timestamp: 2, valueStroops: 101n },
    )).toBeNull()
  })
})
