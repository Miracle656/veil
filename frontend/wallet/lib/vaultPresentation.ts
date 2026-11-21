export const VAULT_COPY = {
  exitTermsTitle: 'Exit terms',
  emissionsQueued: 'Emissions stop while a withdrawal is queued.',
  interestQueued: 'Pool interest continues while the withdrawal is queued.',
  riskFirstLoss:
    'This is a first-loss position. Share value can fall, and you can lose part or all of your position.',
  cancellation: 'You can cancel a pending withdrawal. Cancellation removes the queue and reverses the reserved amount.',
  historyUnavailable:
    'Position value history is unavailable. Veil does not currently receive share-value snapshots or position-value events.',
  depositConfirmation:
    'I understand this deposit is a first-loss position and withdrawals follow the configured queue.',
  maturityLabel: 'Matures',
  cancelLabel: 'Cancel withdrawal',
  cancelPending: 'Cancelling...',
} as const

export function queueMaturityTimestamp(queuedAt: number, delaySeconds: number): number {
  if (!Number.isSafeInteger(queuedAt) || queuedAt < 0) {
    throw new Error('Queue timestamp is invalid.')
  }
  if (!Number.isSafeInteger(delaySeconds) || delaySeconds <= 0) {
    throw new Error('Queue delay is invalid.')
  }
  const maturity = queuedAt + delaySeconds
  if (!Number.isSafeInteger(maturity)) {
    throw new Error('Queue maturity timestamp is outside the supported range.')
  }
  return maturity
}

export function formatAbsoluteTimestamp(
  timestamp: number,
  locale?: string,
  timeZone?: string,
): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(new Date(timestamp * 1_000))
}

export interface VaultPositionValueSnapshot {
  timestamp: number
  valueStroops: bigint
}

export interface VaultPositionValueDrop {
  previousStroops: bigint
  currentStroops: bigint
  amountXlm: string
  percentage: number
}

export function formatVaultPositionXlm(stroops: bigint): string {
  const whole = stroops / 10_000_000n
  const fraction = (stroops % 10_000_000n)
    .toString()
    .padStart(7, '0')
    .replace(/0+$/, '')
  return `${whole}${fraction ? `.${fraction}` : ''}`
}

export function positionValueDrop(
  previous: VaultPositionValueSnapshot,
  current: VaultPositionValueSnapshot,
): VaultPositionValueDrop | null {
  if (current.valueStroops >= previous.valueStroops) return null
  if (previous.valueStroops <= 0n) return null

  const amount = previous.valueStroops - current.valueStroops
  const percentage = Number((amount * 10_000n) / previous.valueStroops) / 100
  return {
    previousStroops: previous.valueStroops,
    currentStroops: current.valueStroops,
    amountXlm: formatVaultPositionXlm(amount),
    percentage,
  }
}
