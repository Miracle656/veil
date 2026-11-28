import { poolStatusInfo } from '../blendStatus'

describe('poolStatusInfo', () => {
  it.each([0, 1])('status %i is active and says nothing', (status) => {
    expect(poolStatusInfo(status)).toEqual({ state: 'active', canSupply: true, label: null, notice: null })
  })

  it.each([2, 3])('status %i is on ice: deposits still allowed, and the person is told', (status) => {
    const info = poolStatusInfo(status)
    expect(info.state).toBe('on-ice')
    expect(info.canSupply).toBe(true)
    expect(info.label).toBe('Borrowing paused')
    expect(info.notice).toMatch(/paused new borrowing/)
    expect(info.notice).toMatch(/still deposit and withdraw/)
    expect(info.notice).toMatch(/rate shown may fall/)
  })

  it.each([4, 5])('status %i is frozen: no deposits, withdrawals still possible', (status) => {
    const info = poolStatusInfo(status)
    expect(info.state).toBe('frozen')
    expect(info.canSupply).toBe(false)
    expect(info.notice).toMatch(/still withdraw/)
  })

  it('status 6 is setup: no deposits', () => {
    expect(poolStatusInfo(6)).toMatchObject({ state: 'setup', canSupply: false })
  })

  it.each([null, undefined, 7, -1, 1.5, NaN])(
    'an unreadable status (%p) is unknown, warned about, and not blocked',
    (status) => {
      const info = poolStatusInfo(status as number | null | undefined)
      expect(info.state).toBe('unknown')
      expect(info.canSupply).toBe(true)
      expect(info.notice).toMatch(/could not read/)
    },
  )

  it('every state other than active has a label and a notice', () => {
    for (const status of [2, 3, 4, 5, 6, 99, null]) {
      expect(poolStatusInfo(status).notice).toBeTruthy()
      expect(poolStatusInfo(status).label).toBeTruthy()
    }
  })
})
