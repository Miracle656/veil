import {
  formatDelayInDays,
  formatLocalDateTime,
  projectedUnlockTimestamp,
  sendAmountLimitMessage,
  vaultWithdrawalState,
} from '../savings'
import { maxSendable } from '../sendable'

describe('savings timing', () => {
  it('projects unlock from the chain timestamp and vault delay in seconds', () => {
    expect(projectedUnlockTimestamp(1_800_000_000, 86_400)).toBe(1_800_086_400)
    expect(formatDelayInDays(86_400)).toBe('1 day (1 day)')
  })

  it('formats the same timestamp in the requested local timezone and names that timezone', () => {
    const timestamp = Math.floor(Date.parse('2026-01-15T12:00:00Z') / 1_000)
    const formatted = formatLocalDateTime(timestamp, 'America/New_York', 'en-US')

    expect(formatted).toContain('January 15, 2026')
    expect(formatted).toContain('7:00:00 AM')
    expect(formatted).toContain('America/New_York')
  })

  it('shows fractional-day terms alongside the exact configured duration', () => {
    expect(formatDelayInDays(3_600)).toBe('0.041666667 days (1 hour)')
  })
})

describe('locked savings send guard copy', () => {
  it('explains that vault funds are excluded when a send exceeds the wallet balance', () => {
    expect(sendAmountLimitMessage({
      amount: 2,
      spendable: 1,
      lockedAmount: 5,
      lockedExplanation: 'If queued now, earliest reach is November 24 at 3:00 PM (Europe/Paris).',
    })).toBe(
      'Only 1 XLM is spendable from this wallet. 5 XLM is locked in your vault and is not included in Send. If queued now, earliest reach is November 24 at 3:00 PM (Europe/Paris).',
    )
  })

  describe('queued vault withdrawal state', () => {
    const withdrawal = { unlockAt: 1_800_000_000, cancelled: false, executed: false }

    it('distinguishes waiting, executable, and cancelled withdrawals', () => {
      expect(vaultWithdrawalState(withdrawal, 1_799_999_999)).toBe('Waiting')
      expect(vaultWithdrawalState(withdrawal, 1_800_000_000)).toBe('Executable')
      expect(vaultWithdrawalState({ ...withdrawal, cancelled: true }, 1_800_000_000)).toBe('Cancelled')
    })
  })

  it('does not report a locked-funds error for an amount within the source balance', () => {
    expect(sendAmountLimitMessage({ amount: 0.9, spendable: 1, lockedAmount: 5 })).toBeNull()
  })

  it('keeps vault-held XLM out of the selected account balance and explains an over-limit attempt', () => {
    const accountAsset = {
      code: 'XLM',
      issuer: null,
      balance: '2',
      spendable: '1',
    }
    const spendable = maxSendable(accountAsset, 0)

    expect(spendable).toBe(1)
    expect(sendAmountLimitMessage({
      amount: 1.5,
      spendable,
      lockedAmount: 5,
      lockedExplanation: '5 XLM is locked until January 16, 2026 at 7:00:00 AM EST (America/New_York).',
    })).toContain('5 XLM is locked until January 16, 2026')
  })
})
