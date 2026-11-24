const SECONDS_PER_DAY = 86_400

export type SavingsMode = 'flexible' | 'locked'

export interface VaultWithdrawalState {
  unlockAt: number
  cancelled: boolean
  executed: boolean
}

export function vaultWithdrawalState(
  withdrawal: VaultWithdrawalState,
  now: number,
): 'Waiting' | 'Executable' | 'Cancelled' | 'Executed' {
  if (withdrawal.executed) return 'Executed'
  if (withdrawal.cancelled) return 'Cancelled'
  return now >= withdrawal.unlockAt ? 'Executable' : 'Waiting'
}

export function projectedUnlockTimestamp(ledgerTimestamp: number, delaySeconds: number): number {
  if (!Number.isSafeInteger(ledgerTimestamp) || ledgerTimestamp < 0) {
    throw new Error('Current ledger timestamp is invalid.')
  }
  if (!Number.isSafeInteger(delaySeconds) || delaySeconds <= 0) {
    throw new Error('Vault withdrawal delay is invalid.')
  }
  const unlockAt = ledgerTimestamp + delaySeconds
  if (!Number.isSafeInteger(unlockAt)) {
    throw new Error('Projected unlock time is outside the supported range.')
  }
  return unlockAt
}

export function formatDelayInDays(delaySeconds: number): string {
  if (!Number.isSafeInteger(delaySeconds) || delaySeconds <= 0) {
    throw new Error('Vault withdrawal delay is invalid.')
  }
  const days = delaySeconds / SECONDS_PER_DAY
  const dayText = new Intl.NumberFormat(undefined, {
    maximumSignificantDigits: 8,
  }).format(days)
  let exactDuration: string
  if (delaySeconds % SECONDS_PER_DAY === 0) {
    const wholeDays = delaySeconds / SECONDS_PER_DAY
    exactDuration = `${wholeDays} day${wholeDays === 1 ? '' : 's'}`
  } else if (delaySeconds % 3_600 === 0) {
    const hours = delaySeconds / 3_600
    exactDuration = `${hours} hour${hours === 1 ? '' : 's'}`
  } else {
    exactDuration = `${delaySeconds.toLocaleString()} seconds`
  }
  return `${dayText} day${days === 1 ? '' : 's'} (${exactDuration})`
}

export function formatLocalDateTime(
  timestamp: number,
  timeZone?: string,
  locale?: string,
): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error('Unlock timestamp is invalid.')
  }
  const localTimeZone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const formatted = new Intl.DateTimeFormat(locale, {
    timeZone: localTimeZone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(timestamp * 1_000))
  return `${formatted} (${localTimeZone})`
}

export function sendAmountLimitMessage(params: {
  amount: number
  spendable: number
  lockedAmount: number
  assetCode?: string
  lockedExplanation?: string
}): string | null {
  if (!Number.isFinite(params.amount) || params.amount <= 0) return null
  if (!Number.isFinite(params.spendable) || params.spendable < 0) {
    return 'Could not verify the amount available to send from this wallet.'
  }
  if (params.amount <= params.spendable) return null
  const assetCode = params.assetCode ?? 'XLM'
  if (params.lockedAmount > 0) {
    return `Only ${params.spendable} ${assetCode} is spendable from this wallet. ${params.lockedAmount} ${assetCode} is locked in your vault and is not included in Send. ${params.lockedExplanation ?? ''}`.trim()
  }
  return `This amount is above the ${params.spendable} ${assetCode} available to send from this wallet.`
}
