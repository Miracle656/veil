import { randomUUID } from 'node:crypto'
import { StrKey } from '@stellar/stellar-sdk'
import { classifyAllowanceError, type AllowancePayer } from './allowance.js'
import { assertNoNin, maskPhoneNumber, normalizeNigerianPhone, scrubLogMessage } from './privacy.js'
import type { PlanStore } from './store.js'
import type {
  CreateRecurringTopupInput,
  NairaCoin,
  PeriodRecord,
  PlanStopReason,
  PublicRecurringTopupPlan,
  RecurringTopupActivityItem,
  RecurringTopupPlan,
  TopupCategory,
  TopupFrequency,
  TopupProvider,
} from './types.js'
import {
  classifyBillStatus,
  lockBillAmountStableCoin,
  stableCoinToBaseUnits,
  type WraithBillClient,
} from './wraith.js'

const VALID_CATEGORIES = new Set<TopupCategory>(['airtime', 'data'])
const VALID_PROVIDERS = new Set<TopupProvider>(['MTN', 'AIRTEL', 'GLO', '9MOBILE'])
const VALID_FREQUENCIES = new Set<TopupFrequency>(['daily', 'weekly', 'biweekly', 'monthly'])
const VALID_COINS = new Set<NairaCoin>(['usdc', 'xlm'])

export const MAX_TOTAL_PERIODS = 52
export const MIN_AMOUNT_NGN = 50
export const MAX_AMOUNT_NGN = 500_000

const FREQUENCY_MS: Record<TopupFrequency, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  biweekly: 14 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
}

/**
 * Build a deterministic idempotency key for a specific plan period.
 * One period, one order — retries and restarts produce the exact same key.
 */
export function buildPeriodIdempotencyKey(planId: string, periodIndex: number): string {
  return `recurring_topup:${planId}:period:${periodIndex}`
}

/**
 * Compute the ISO-8601 due timestamp for a 0-based period index.
 */
export function computePeriodDueAt(
  startIso: string,
  frequency: TopupFrequency,
  periodIndex: number,
): string {
  const startMs = Date.parse(startIso)
  return new Date(startMs + periodIndex * FREQUENCY_MS[frequency]).toISOString()
}

function stopReasonProse(reason: PlanStopReason): string {
  switch (reason) {
    case 'allowance_used_up':
      return 'the allowance was used up'
    case 'allowance_expired':
      return 'the allowance expired'
    case 'allowance_revoked':
      return 'the allowance was revoked or stopped'
    case 'allowance_insufficient':
      return 'the remaining allowance could not cover the next payment'
  }
}

/**
 * Build a clear user-facing explanation of why a plan stopped, what was paid
 * (with full transaction hashes), and what was not paid.
 */
export function formatStopMessage(plan: RecurringTopupPlan, reason: PlanStopReason): string {
  const paidPeriods = plan.periods.filter(
    (p) => p.status === 'paid' || p.status === 'delivered' || p.status === 'failed_after_payment',
  )
  const unpaidCount = Math.max(0, plan.totalPeriods - paidPeriods.length)
  const paidTotalNgn = paidPeriods.reduce((sum, p) => sum + p.amountNgn, 0)
  const unpaidTotalNgn = unpaidCount * plan.amountNgn

  const paidHashes = paidPeriods
    .map((p) => p.txHash)
    .filter((h): h is string => typeof h === 'string' && h.length > 0)

  const paidPart =
    paidPeriods.length === 0
      ? 'Paid: none (0 periods).'
      : `Paid: ${paidPeriods.length} of ${plan.totalPeriods} periods (₦${paidTotalNgn.toLocaleString('en-NG')}; tx: ${paidHashes.join(', ')}).`

  const unpaidPart = `Not paid: ${unpaidCount} remaining period${unpaidCount === 1 ? '' : 's'} (₦${unpaidTotalNgn.toLocaleString('en-NG')}).`

  return `Stopped because ${stopReasonProse(reason)}. Nothing was submitted for the due period. ${paidPart} ${unpaidPart}`
}

/**
 * Strip raw personal phone number when returning a plan to chat, UI, or APIs.
 */
export function toPublicPlan(plan: RecurringTopupPlan): PublicRecurringTopupPlan {
  const { phoneNumber, ...rest } = plan
  const paidCount = plan.periods.filter(
    (p) => p.status === 'paid' || p.status === 'delivered',
  ).length
  const failedAfterPaymentCount = plan.periods.filter(
    (p) => p.status === 'failed_after_payment',
  ).length
  const settledCount = paidCount + failedAfterPaymentCount
  const unpaidCount = Math.max(0, plan.totalPeriods - settledCount)

  return {
    ...rest,
    maskedPhone: maskPhoneNumber(phoneNumber),
    paidCount,
    failedAfterPaymentCount,
    unpaidCount,
  }
}

export interface PeriodRunOutcome {
  planId: string
  periodIndex: number
  idempotencyKey: string
  action:
    | 'paid'
    | 'delivered'
    | 'failed_after_payment'
    | 'stopped_allowance'
    | 'already_handled'
    | 'error'
  orderId?: string
  txHash?: string
  stopReason?: PlanStopReason
  message?: string
}

export interface RecurringTopupRunnerOptions {
  store: PlanStore
  wraith: WraithBillClient
  payer: AllowancePayer
  now?: () => number
  logger?: {
    info?: (msg: string) => void
    warn?: (msg: string) => void
    error?: (msg: string) => void
  }
}

/**
 * Server-side scheduler and executor for recurring airtime/data top-up plans.
 *
 * Invariants enforced:
 * 1. One period, one order: deterministic idempotency key per (planId, periodIndex),
 *    persisted BEFORE payment so retries and server restarts never create a second
 *    wraith order or submit a second payment.
 * 2. Allowance checked before submission: if used up, expired, revoked, or too
 *    small, nothing is submitted to wraith or Stellar, the plan stops cleanly,
 *    and the user is told why and what was and was not paid.
 * 3. Order failure after payment: recorded and surfaced with full txHash; never
 *    paid again for the same period.
 * 4. Personal data: phone numbers are never logged; NIN is rejected everywhere.
 */
export class RecurringTopupRunner {
  private readonly store: PlanStore
  private readonly wraith: WraithBillClient
  private readonly payer: AllowancePayer
  private readonly now: () => number
  private readonly logger: NonNullable<RecurringTopupRunnerOptions['logger']>
  private readonly inFlight = new Set<string>()

  constructor(options: RecurringTopupRunnerOptions) {
    this.store = options.store
    this.wraith = options.wraith
    this.payer = options.payer
    this.now = options.now ?? Date.now
    this.logger = options.logger ?? {
      info: (m) => console.log(m),
      warn: (m) => console.warn(m),
      error: (m) => console.error(m),
    }
  }

  private log(level: 'info' | 'warn' | 'error', message: string, phones: string[] = []): void {
    const safe = scrubLogMessage(message, phones)
    this.logger[level]?.(safe)
  }

  async createPlan(input: CreateRecurringTopupInput): Promise<PublicRecurringTopupPlan> {
    assertNoNin(input)

    if (!StrKey.isValidContract(input.walletAddress)) {
      throw new Error('walletAddress must be a valid Soroban wallet contract address (C...).')
    }
    if (!StrKey.isValidEd25519PublicKey(input.refundAddress)) {
      throw new Error('refundAddress must be a valid classic Stellar address (G...).')
    }
    if (
      !StrKey.isValidEd25519PublicKey(input.spenderAddress) &&
      !StrKey.isValidContract(input.spenderAddress)
    ) {
      throw new Error('spenderAddress must be a valid Stellar address (G... or C...).')
    }
    if (!StrKey.isValidContract(input.tokenContractId)) {
      throw new Error('tokenContractId must be a valid Soroban token contract ID (C...).')
    }
    if (!input.customerRef || !input.customerRef.trim()) {
      throw new Error('customerRef is required.')
    }
    if (!VALID_CATEGORIES.has(input.category)) {
      throw new Error('category must be "airtime" or "data".')
    }
    if (!VALID_PROVIDERS.has(input.provider)) {
      throw new Error('provider must be one of MTN, AIRTEL, GLO, or 9MOBILE.')
    }
    const phone = normalizeNigerianPhone(input.phoneNumber)
    if (!phone) {
      throw new Error('phoneNumber must be a valid Nigerian mobile number.')
    }
    if (
      typeof input.amountNgn !== 'number' ||
      !Number.isFinite(input.amountNgn) ||
      input.amountNgn < MIN_AMOUNT_NGN ||
      input.amountNgn > MAX_AMOUNT_NGN
    ) {
      throw new Error(
        `amountNgn must be between ₦${MIN_AMOUNT_NGN} and ₦${MAX_AMOUNT_NGN.toLocaleString('en-NG')}.`,
      )
    }
    const coin: NairaCoin = input.coin ?? 'usdc'
    if (!VALID_COINS.has(coin)) {
      throw new Error('coin must be "usdc" or "xlm".')
    }
    if (!VALID_FREQUENCIES.has(input.frequency)) {
      throw new Error('frequency must be daily, weekly, biweekly, or monthly.')
    }
    if (
      !Number.isInteger(input.totalPeriods) ||
      input.totalPeriods < 1 ||
      input.totalPeriods > MAX_TOTAL_PERIODS
    ) {
      throw new Error(`totalPeriods must be an integer between 1 and ${MAX_TOTAL_PERIODS}.`)
    }

    const nowIso = new Date(this.now()).toISOString()
    const firstDueAt = input.startAt && Number.isFinite(Date.parse(input.startAt))
      ? new Date(Date.parse(input.startAt)).toISOString()
      : nowIso

    const plan: RecurringTopupPlan = {
      id: `plan_${randomUUID()}`,
      walletAddress: input.walletAddress,
      refundAddress: input.refundAddress,
      spenderAddress: input.spenderAddress,
      tokenContractId: input.tokenContractId,
      customerRef: input.customerRef.trim(),
      category: input.category,
      provider: input.provider,
      phoneNumber: phone,
      amountNgn: Math.round(input.amountNgn),
      coin,
      frequency: input.frequency,
      totalPeriods: input.totalPeriods,
      status: 'active',
      createdAt: nowIso,
      nextDueAt: firstDueAt,
      updatedAt: nowIso,
      periods: [],
    }

    await this.store.create(plan)
    this.log(
      'info',
      `[recurring-topup] created plan ${plan.id} for wallet ${plan.walletAddress} (${plan.category} ${plan.provider} ₦${plan.amountNgn} ${plan.frequency} x${plan.totalPeriods})`,
      [phone],
    )
    return toPublicPlan(plan)
  }

  async listPlans(walletAddress: string): Promise<PublicRecurringTopupPlan[]> {
    const plans = await this.store.listByWallet(walletAddress)
    return plans.map(toPublicPlan)
  }

  async cancelPlan(walletAddress: string, planId: string): Promise<PublicRecurringTopupPlan> {
    const plan = await this.store.get(planId)
    if (!plan || plan.walletAddress !== walletAddress) {
      throw new Error(`Plan ${planId} was not found for this wallet.`)
    }
    if (plan.status === 'cancelled') {
      return toPublicPlan(plan)
    }
    if (plan.status === 'completed') {
      throw new Error('This plan has already completed and cannot be cancelled.')
    }

    plan.status = 'cancelled'
    plan.nextDueAt = null
    plan.updatedAt = new Date(this.now()).toISOString()
    await this.store.save(plan)
    this.log('info', `[recurring-topup] cancelled plan ${plan.id}`, [plan.phoneNumber])
    return toPublicPlan(plan)
  }

  async getActivityForWallet(walletAddress: string): Promise<RecurringTopupActivityItem[]> {
    const plans = await this.store.listByWallet(walletAddress)
    const items: RecurringTopupActivityItem[] = []
    for (const plan of plans) {
      const maskedPhone = maskPhoneNumber(plan.phoneNumber)
      for (const period of plan.periods) {
        if (
          (period.status === 'paid' ||
            period.status === 'delivered' ||
            period.status === 'failed_after_payment') &&
          period.txHash &&
          period.orderId &&
          period.depositAddress &&
          period.amountStableCoin !== undefined
        ) {
          items.push({
            id: period.idempotencyKey,
            planId: plan.id,
            periodIndex: period.periodIndex,
            category: plan.category,
            provider: plan.provider,
            maskedPhone,
            amountNgn: period.amountNgn,
            amountStableCoin: period.amountStableCoin,
            coin: period.coin,
            txHash: period.txHash,
            orderId: period.orderId,
            depositAddress: period.depositAddress,
            status: period.status,
            errorMessage: period.errorMessage,
            timestamp: Math.floor(Date.parse(period.updatedAt) / 1000),
          })
        }
      }
    }
    return items.sort((a, b) => b.timestamp - a.timestamp)
  }

  async runDuePlans(nowMs: number = this.now()): Promise<PeriodRunOutcome[]> {
    const duePlans = await this.store.listDue(nowMs)
    const outcomes: PeriodRunOutcome[] = []
    for (const plan of duePlans) {
      const outcome = await this.runNextDuePeriod(plan.id, nowMs)
      if (outcome) outcomes.push(outcome)
    }
    return outcomes
  }

  async runNextDuePeriod(planId: string, nowMs: number = this.now()): Promise<PeriodRunOutcome | null> {
    const plan = await this.store.get(planId)
    if (!plan || plan.status !== 'active' || !plan.nextDueAt) return null
    if (Date.parse(plan.nextDueAt) > nowMs) return null

    // Determine current period index: first period that has not been settled
    // (paid, delivered, failed_after_payment) yet.
    const settledCount = plan.periods.filter(
      (p) =>
        p.status === 'paid' ||
        p.status === 'delivered' ||
        p.status === 'failed_after_payment',
    ).length

    if (settledCount >= plan.totalPeriods) {
      plan.status = 'completed'
      plan.nextDueAt = null
      plan.updatedAt = new Date(nowMs).toISOString()
      await this.store.save(plan)
      return null
    }

    const periodIndex = settledCount
    const idempotencyKey = buildPeriodIdempotencyKey(plan.id, periodIndex)
    if (this.inFlight.has(idempotencyKey)) {
      return {
        planId: plan.id,
        periodIndex,
        idempotencyKey,
        action: 'already_handled',
        message: 'Period execution already in flight.',
      }
    }

    this.inFlight.add(idempotencyKey)
    try {
      return await this.executePeriod(plan, periodIndex, idempotencyKey, nowMs)
    } finally {
      this.inFlight.delete(idempotencyKey)
    }
  }

  private async executePeriod(
    plan: RecurringTopupPlan,
    periodIndex: number,
    idempotencyKey: string,
    nowMs: number,
  ): Promise<PeriodRunOutcome> {
    const nowIso = new Date(nowMs).toISOString()
    const nowSecs = BigInt(Math.floor(nowMs / 1000))
    let record = plan.periods.find((p) => p.idempotencyKey === idempotencyKey)

    // Guard: if this period was already paid, delivered, or failed after payment,
    // NEVER create another order and NEVER pay again.
    if (
      record &&
      (record.status === 'paid' ||
        record.status === 'delivered' ||
        record.status === 'failed_after_payment')
    ) {
      return {
        planId: plan.id,
        periodIndex,
        idempotencyKey,
        action: 'already_handled',
        orderId: record.orderId,
        txHash: record.txHash,
      }
    }

    const stopForAllowance = async (reason: PlanStopReason): Promise<PeriodRunOutcome> => {
      const skipped: PeriodRecord = record ?? {
        periodIndex,
        dueAt: plan.nextDueAt ?? nowIso,
        idempotencyKey,
        status: 'skipped_allowance',
        amountNgn: plan.amountNgn,
        coin: plan.coin,
        updatedAt: nowIso,
      }
      skipped.status = 'skipped_allowance'
      skipped.errorMessage = stopReasonProse(reason)
      skipped.updatedAt = nowIso
      upsertPeriod(plan, skipped)

      plan.status = 'stopped'
      plan.stopReason = reason
      plan.nextDueAt = null
      plan.stopMessage = formatStopMessage(plan, reason)
      plan.updatedAt = nowIso
      await this.store.save(plan)

      this.log(
        'warn',
        `[recurring-topup] stopped plan ${plan.id} at period ${periodIndex}: ${reason}`,
        [plan.phoneNumber],
      )

      return {
        planId: plan.id,
        periodIndex,
        idempotencyKey,
        action: 'stopped_allowance',
        stopReason: reason,
        message: plan.stopMessage,
      }
    }

    // Step 1: Reserve order if not already reserved (restart/retry safe).
    if (!record || record.status !== 'order_reserved' || !record.orderId || !record.depositAddress || !record.amountStableCoin) {
      const rate = await this.wraith.getBillRate(plan.coin)
      const amountStableCoin = lockBillAmountStableCoin(plan.amountNgn, rate)
      const requiredBaseUnits = stableCoinToBaseUnits(amountStableCoin)

      // Check allowance BEFORE creating any order or submitting any payment!
      const allowanceCheck = await this.payer.checkAllowance({
        walletAddress: plan.walletAddress,
        spenderAddress: plan.spenderAddress,
        tokenContractId: plan.tokenContractId,
        requiredBaseUnits,
        nowSecs,
      })
      if (!allowanceCheck.ok) {
        return stopForAllowance(allowanceCheck.reason)
      }

      // Create wraith bill order with deterministic idempotency key.
      const order = await this.wraith.createBillOrder({
        customerRef: plan.customerRef,
        billCategory: plan.category,
        provider: plan.provider,
        customerId: plan.phoneNumber,
        amountNgn: plan.amountNgn,
        amountStableCoin,
        rate,
        coin: plan.coin,
        refundAddress: plan.refundAddress,
        idempotencyKey,
      })

      record = {
        periodIndex,
        dueAt: plan.nextDueAt ?? nowIso,
        idempotencyKey,
        status: 'order_reserved',
        orderId: order.id,
        depositAddress: order.wallet,
        amountNgn: plan.amountNgn,
        amountStableCoin,
        coin: plan.coin,
        rate,
        orderStatus: order.status,
        updatedAt: nowIso,
      }
      upsertPeriod(plan, record)
      plan.updatedAt = nowIso
      // Persist immediately after reservation so a restart never creates a second order.
      await this.store.save(plan)
    } else {
      // Order was already reserved before a restart; re-check allowance before paying.
      const requiredBaseUnits = stableCoinToBaseUnits(record.amountStableCoin)
      const allowanceCheck = await this.payer.checkAllowance({
        walletAddress: plan.walletAddress,
        spenderAddress: plan.spenderAddress,
        tokenContractId: plan.tokenContractId,
        requiredBaseUnits,
        nowSecs,
      })
      if (!allowanceCheck.ok) {
        return stopForAllowance(allowanceCheck.reason)
      }
    }

    // Step 2: Pay the reserved order from the allowance.
    const requiredBaseUnits = stableCoinToBaseUnits(record.amountStableCoin!)
    let txHash: string
    try {
      const payment = await this.payer.payFromAllowance({
        walletAddress: plan.walletAddress,
        spenderAddress: plan.spenderAddress,
        tokenContractId: plan.tokenContractId,
        destinationAddress: record.depositAddress!,
        amountBaseUnits: requiredBaseUnits,
        idempotencyKey,
      })
      txHash = payment.txHash
    } catch (err) {
      const allowanceReason = classifyAllowanceError(err)
      if (allowanceReason) {
        return stopForAllowance(allowanceReason)
      }
      this.log(
        'error',
        `[recurring-topup] payment failed for plan ${plan.id} period ${periodIndex}: ${(err as Error).message}`,
        [plan.phoneNumber],
      )
      return {
        planId: plan.id,
        periodIndex,
        idempotencyKey,
        action: 'error',
        orderId: record.orderId,
        message: scrubLogMessage((err as Error).message, [plan.phoneNumber]),
      }
    }

    // Persist payment immediately with full txHash before polling status.
    record.status = 'paid'
    record.txHash = txHash
    record.updatedAt = new Date(this.now()).toISOString()
    upsertPeriod(plan, record)

    // Advance schedule or complete plan.
    advanceSchedule(plan, periodIndex, record.dueAt, record.updatedAt)
    await this.store.save(plan)

    // Step 3: Check order delivery status. If it fails after payment, record
    // it and show it, and NEVER pay again for this period.
    let finalAction: 'paid' | 'delivered' | 'failed_after_payment' = 'paid'
    try {
      const status = await this.wraith.getBillStatus(plan.customerRef, record.orderId!)
      record.orderStatus = status.status
      const outcome = classifyBillStatus(status.status)
      if (outcome === 'done') {
        record.status = 'delivered'
        finalAction = 'delivered'
      } else if (outcome === 'failed') {
        record.status = 'failed_after_payment'
        record.errorMessage =
          `Order ${record.orderId} failed after payment (status: ${status.status}). ` +
          `This period will not be paid again; refunds return to ${plan.refundAddress}.`
        finalAction = 'failed_after_payment'
      }
      record.updatedAt = new Date(this.now()).toISOString()
      upsertPeriod(plan, record)
      plan.updatedAt = record.updatedAt
      await this.store.save(plan)
    } catch (err) {
      this.log(
        'warn',
        `[recurring-topup] status check deferred for plan ${plan.id} period ${periodIndex}: ${(err as Error).message}`,
        [plan.phoneNumber],
      )
    }

    this.log(
      'info',
      `[recurring-topup] plan ${plan.id} period ${periodIndex} ${finalAction} order=${record.orderId} tx=${txHash}`,
      [plan.phoneNumber],
    )

    return {
      planId: plan.id,
      periodIndex,
      idempotencyKey,
      action: finalAction,
      orderId: record.orderId,
      txHash,
      message: record.errorMessage,
    }
  }
}

function upsertPeriod(plan: RecurringTopupPlan, record: PeriodRecord): void {
  const idx = plan.periods.findIndex((p) => p.idempotencyKey === record.idempotencyKey)
  if (idx >= 0) {
    plan.periods[idx] = { ...record }
  } else {
    plan.periods.push({ ...record })
  }
}

function advanceSchedule(
  plan: RecurringTopupPlan,
  completedPeriodIndex: number,
  currentDueAt: string,
  nowIso: string,
): void {
  const nextIndex = completedPeriodIndex + 1
  if (nextIndex >= plan.totalPeriods) {
    plan.status = 'completed'
    plan.nextDueAt = null
  } else {
    plan.nextDueAt = computePeriodDueAt(currentDueAt, plan.frequency, 1)
  }
  plan.updatedAt = nowIso
}
