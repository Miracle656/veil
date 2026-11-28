/**
 * Recurring airtime and data top-up plan types.
 *
 * Every Stellar address, contract ID, and transaction hash stored or returned
 * here is kept in full — never shortened.
 */

export type TopupCategory = 'airtime' | 'data'

export type TopupProvider = 'MTN' | 'AIRTEL' | 'GLO' | '9MOBILE'

export type TopupFrequency = 'daily' | 'weekly' | 'biweekly' | 'monthly'

export type NairaCoin = 'usdc' | 'xlm'

export type PlanStatus = 'active' | 'completed' | 'stopped' | 'cancelled'

export type PlanStopReason =
  | 'allowance_used_up'
  | 'allowance_expired'
  | 'allowance_revoked'
  | 'allowance_insufficient'

export type PeriodExecutionStatus =
  | 'order_reserved'
  | 'paid'
  | 'delivered'
  | 'failed_after_payment'
  | 'skipped_allowance'

export interface PeriodRecord {
  periodIndex: number
  dueAt: string
  /** Deterministic key built from planId and periodIndex: one period, one order. */
  idempotencyKey: string
  status: PeriodExecutionStatus
  orderId?: string
  /** Classic G... deposit address returned by wraith for this order. */
  depositAddress?: string
  amountNgn: number
  amountStableCoin?: number
  coin: NairaCoin
  rate?: number
  /** Full 64-character Stellar transaction hash, never shortened. */
  txHash?: string
  orderStatus?: string
  errorMessage?: string
  updatedAt: string
}

/**
 * Persisted recurring top-up plan.
 *
 * Personal data minimization: only the phone number required to vend the
 * top-up is stored here. NIN is never stored, logged, or passed to tools.
 */
export interface RecurringTopupPlan {
  id: string
  /** User's smart wallet contract address (full C... address). */
  walletAddress: string
  /** User's classic refund address (full G... address) for biller refunds. */
  refundAddress: string
  /** Assistant's spender address granted an allowance on the wallet contract. */
  spenderAddress: string
  /** Soroban token SAC contract ID (full C... address) the allowance covers. */
  tokenContractId: string
  /** Stable wraith/Linq customer reference (never a NIN). */
  customerRef: string
  category: TopupCategory
  provider: TopupProvider
  /** Normalized Nigerian phone number. Kept out of logs and public summaries. */
  phoneNumber: string
  amountNgn: number
  coin: NairaCoin
  frequency: TopupFrequency
  totalPeriods: number
  status: PlanStatus
  stopReason?: PlanStopReason
  stopMessage?: string
  createdAt: string
  nextDueAt: string | null
  updatedAt: string
  periods: PeriodRecord[]
}

/**
 * Safe view of a plan for chat, API responses, and UI screens.
 * Replaces raw `phoneNumber` with `maskedPhone`.
 */
export interface PublicRecurringTopupPlan extends Omit<RecurringTopupPlan, 'phoneNumber'> {
  maskedPhone: string
  paidCount: number
  failedAfterPaymentCount: number
  unpaidCount: number
}

/**
 * Payment entry surfaced in the user's Activity feed.
 * Always carries the full transaction hash.
 */
export interface RecurringTopupActivityItem {
  id: string
  planId: string
  periodIndex: number
  category: TopupCategory
  provider: TopupProvider
  maskedPhone: string
  amountNgn: number
  amountStableCoin: number
  coin: NairaCoin
  /** Full 64-character Stellar transaction hash, never shortened. */
  txHash: string
  orderId: string
  depositAddress: string
  status: 'paid' | 'delivered' | 'failed_after_payment'
  errorMessage?: string
  timestamp: number
}

export interface CreateRecurringTopupInput {
  walletAddress: string
  refundAddress: string
  spenderAddress: string
  tokenContractId: string
  customerRef: string
  category: TopupCategory
  provider: TopupProvider
  phoneNumber: string
  amountNgn: number
  coin?: NairaCoin
  frequency: TopupFrequency
  totalPeriods: number
  startAt?: string
}

export interface RecurringTopupIntent {
  category: TopupCategory
  provider: TopupProvider
  maskedPhone: string
  /** Normalized phone number passed to the confirmation hand-off only, never logged. */
  phoneNumber: string
  amountNgn: number
  coin: NairaCoin
  frequency: TopupFrequency
  totalPeriods: number
}

export interface CancelTopupIntent {
  planId: string
}
