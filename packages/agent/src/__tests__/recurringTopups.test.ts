import { describe, it, expect, jest } from '@jest/globals'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { StrKey } from '@stellar/stellar-sdk'
import {
  AllowanceRejectedError,
  buildPeriodIdempotencyKey,
  evaluateAllowance,
  EXPIRY_TOLERANCE_SECS,
  FilePlanStore,
  InMemoryPlanStore,
  RecurringTopupRunner,
  scrubLogMessage,
  type AllowanceCheckParams,
  type AllowanceCheckResult,
  type AllowancePayer,
  type AllowancePaymentParams,
  type CreateWraithBillOrderParams,
  type WraithBillClient,
} from '../recurring/index.js'
import { runAgent } from '../agent.js'
import { createAgentServer } from '../server.js'
import type { LlmProvider, LlmTurn } from '../llm.js'

// Full Stellar addresses and contract IDs (never shortened).
const WALLET_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 0x11))
const USDC_SAC_CONTRACT = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
const REFUND_ACCOUNT = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0x22))
const SPENDER_ACCOUNT = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0x33))
const DEPOSIT_ACCOUNT = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0x44))

const FULL_TX_HASH_1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
const FULL_TX_HASH_2 = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0'

const PHONE_RAW = '08031234567'
const CUSTOMER_REF = 'veil_abcd1234ef56'

function makeWraithMock(overrides: Partial<WraithBillClient> = {}) {
  const createOrderCalls: CreateWraithBillOrderParams[] = []
  let orderCounter = 0

  const client: WraithBillClient = {
    getBillRate: jest.fn(async () => 1600),
    createBillOrder: jest.fn(async (params: CreateWraithBillOrderParams) => {
      createOrderCalls.push(params)
      orderCounter += 1
      return {
        id: `ord_${orderCounter}`,
        customerRef: params.customerRef,
        wallet: DEPOSIT_ACCOUNT,
        status: 'pending',
      }
    }),
    getBillStatus: jest.fn(async (customerRef: string, orderId: string) => ({
      orderId,
      customerRef,
      status: 'settled',
      billCategory: 'airtime',
      amountNgn: 500,
      amountStableCoin: 0.3125,
      wallet: DEPOSIT_ACCOUNT,
    })),
    ...overrides,
  }

  return { client, createOrderCalls }
}

function makePayerMock(options: {
  initialAllowance?: bigint
  expiry?: bigint | null
  revoked?: boolean
  txHashes?: string[]
  failPaymentWith?: Error
} = {}) {
  let remaining = options.initialAllowance ?? 50_000_000n // 5 USDC (7 decimals)
  const expiry = options.expiry ?? null
  let revoked = options.revoked ?? false
  const txHashes = [...(options.txHashes ?? [FULL_TX_HASH_1, FULL_TX_HASH_2])]
  let payCount = 0

  const payer: AllowancePayer = {
    checkAllowance: jest.fn(async (params: AllowanceCheckParams): Promise<AllowanceCheckResult> => {
      if (revoked) {
        return evaluateAllowance(null, params.requiredBaseUnits, params.nowSecs ?? 1_700_000_000n)
      }
      return evaluateAllowance(
        { amount: remaining, expiry },
        params.requiredBaseUnits,
        params.nowSecs ?? 1_700_000_000n,
      )
    }),
    payFromAllowance: jest.fn(async (params: AllowancePaymentParams) => {
      if (options.failPaymentWith) throw options.failPaymentWith
      if (params.amountBaseUnits > remaining) {
        throw new AllowanceRejectedError('allowance_insufficient', 'InsufficientAllowance')
      }
      remaining -= params.amountBaseUnits
      const txHash = txHashes[payCount] ?? FULL_TX_HASH_1
      payCount += 1
      return { txHash }
    }),
  }

  return {
    payer,
    setRemaining: (v: bigint) => {
      remaining = v
    },
    setRevoked: (v: boolean) => {
      revoked = v
    },
    getPayCount: () => payCount,
  }
}

function scriptedLlm(turns: LlmTurn[]): LlmProvider & { toolResults: { id: string; content: string }[][] } {
  const toolResults: { id: string; content: string }[][] = []
  return {
    label: 'scripted',
    toolResults,
    start() {
      let i = 0
      return {
        async next() {
          return turns[Math.min(i++, turns.length - 1)]
        },
        addToolResults(r) {
          toolResults.push(r)
        },
      }
    },
  }
}

describe('recurring top-up plans: lifecycle, idempotency, allowance caps, and privacy', () => {
  it('creates, lists, and cancels a plan with masked phone and zero raw phone in logs', async () => {
    const logs: string[] = []
    const store = new InMemoryPlanStore()
    const { client: wraith } = makeWraithMock()
    const { payer } = makePayerMock()
    const nowMs = Date.parse('2026-11-19T10:00:00.000Z')

    const runner = new RecurringTopupRunner({
      store,
      wraith,
      payer,
      now: () => nowMs,
      logger: {
        info: (m) => logs.push(m),
        warn: (m) => logs.push(m),
        error: (m) => logs.push(m),
      },
    })

    const created = await runner.createPlan({
      walletAddress: WALLET_CONTRACT,
      refundAddress: REFUND_ACCOUNT,
      spenderAddress: SPENDER_ACCOUNT,
      tokenContractId: USDC_SAC_CONTRACT,
      customerRef: CUSTOMER_REF,
      category: 'airtime',
      provider: 'MTN',
      phoneNumber: PHONE_RAW,
      amountNgn: 500,
      coin: 'usdc',
      frequency: 'weekly',
      totalPeriods: 4,
    })

    expect(created.status).toBe('active')
    expect(created.maskedPhone).toBe('*******4567')
    expect('phoneNumber' in created).toBe(false)
    expect(created.paidCount).toBe(0)
    expect(created.unpaidCount).toBe(4)

    const listed = await runner.listPlans(WALLET_CONTRACT)
    expect(listed).toHaveLength(1)
    expect(listed[0].id).toBe(created.id)
    expect(listed[0].maskedPhone).toBe('*******4567')

    const cancelled = await runner.cancelPlan(WALLET_CONTRACT, created.id)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.nextDueAt).toBeNull()

    // Cancelled plan never runs when due.
    const outcomes = await runner.runDuePlans(nowMs + 10_000)
    expect(outcomes).toEqual([])

    // Phone number must never appear in any log line.
    for (const line of logs) {
      expect(line).not.toContain(PHONE_RAW)
    }
  })

  it('executes a due period with exactly one order and one payment, safe across retries', async () => {
    const store = new InMemoryPlanStore()
    const { client: wraith, createOrderCalls } = makeWraithMock()
    const { payer, getPayCount } = makePayerMock()
    let clock = Date.parse('2026-11-19T10:00:00.000Z')

    const runner = new RecurringTopupRunner({
      store,
      wraith,
      payer,
      now: () => clock,
      logger: {},
    })

    const plan = await runner.createPlan({
      walletAddress: WALLET_CONTRACT,
      refundAddress: REFUND_ACCOUNT,
      spenderAddress: SPENDER_ACCOUNT,
      tokenContractId: USDC_SAC_CONTRACT,
      customerRef: CUSTOMER_REF,
      category: 'airtime',
      provider: 'MTN',
      phoneNumber: PHONE_RAW,
      amountNgn: 500,
      coin: 'usdc',
      frequency: 'weekly',
      totalPeriods: 3,
      startAt: new Date(clock).toISOString(),
    })

    // First run executes period 0.
    const first = await runner.runDuePlans(clock)
    expect(first).toHaveLength(1)
    expect(first[0].action).toBe('delivered')
    expect(first[0].idempotencyKey).toBe(buildPeriodIdempotencyKey(plan.id, 0))
    expect(first[0].txHash).toBe(FULL_TX_HASH_1)
    expect(createOrderCalls).toHaveLength(1)
    expect(createOrderCalls[0].idempotencyKey).toBe(buildPeriodIdempotencyKey(plan.id, 0))
    expect(getPayCount()).toBe(1)

    // Immediate retry at the same timestamp must NOT create a second order or payment.
    const retry = await runner.runDuePlans(clock)
    expect(retry).toEqual([])
    expect(createOrderCalls).toHaveLength(1)
    expect(getPayCount()).toBe(1)

    // Activity contains the payment with the FULL 64-char transaction hash.
    const activity = await runner.getActivityForWallet(WALLET_CONTRACT)
    expect(activity).toHaveLength(1)
    expect(activity[0].txHash).toBe(FULL_TX_HASH_1)
    expect(activity[0].txHash).toHaveLength(64)
    expect(activity[0].amountNgn).toBe(500)
    expect(activity[0].maskedPhone).toBe('*******4567')
  })

  it('survives a server restart after order reservation without creating a second order', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'veil-recurring-restart-'))
    const storeFile = path.join(dir, 'plans.json')
    try {
      const clock = Date.parse('2026-11-19T10:00:00.000Z')
      const { client: wraith1, createOrderCalls: orders1 } = makeWraithMock()
      // First server instance fails transiently on payment (simulating crash after order reservation).
      const { payer: failingPayer } = makePayerMock({
        failPaymentWith: new Error('network timeout during submission'),
      })

      const store1 = new FilePlanStore(storeFile)
      const runner1 = new RecurringTopupRunner({
        store: store1,
        wraith: wraith1,
        payer: failingPayer,
        now: () => clock,
        logger: {},
      })

      const plan = await runner1.createPlan({
        walletAddress: WALLET_CONTRACT,
        refundAddress: REFUND_ACCOUNT,
        spenderAddress: SPENDER_ACCOUNT,
        tokenContractId: USDC_SAC_CONTRACT,
        customerRef: CUSTOMER_REF,
        category: 'data',
        provider: 'AIRTEL',
        phoneNumber: PHONE_RAW,
        amountNgn: 1000,
        coin: 'usdc',
        frequency: 'weekly',
        totalPeriods: 2,
        startAt: new Date(clock).toISOString(),
      })

      const firstRun = await runner1.runDuePlans(clock)
      expect(firstRun[0].action).toBe('error')
      expect(orders1).toHaveLength(1)

      // Simulate full server restart: brand new FilePlanStore + brand new Runner reading same file.
      const store2 = new FilePlanStore(storeFile)
      const { client: wraith2, createOrderCalls: orders2 } = makeWraithMock()
      const { payer: healthyPayer, getPayCount } = makePayerMock({ txHashes: [FULL_TX_HASH_1] })
      const runner2 = new RecurringTopupRunner({
        store: store2,
        wraith: wraith2,
        payer: healthyPayer,
        now: () => clock + 60_000,
        logger: {},
      })

      const afterRestart = await runner2.runDuePlans(clock + 60_000)
      expect(afterRestart).toHaveLength(1)
      expect(afterRestart[0].action).toBe('delivered')
      expect(afterRestart[0].orderId).toBe('ord_1')
      expect(afterRestart[0].txHash).toBe(FULL_TX_HASH_1)
      // Must NOT have called createBillOrder a second time!
      expect(orders2).toHaveLength(0)
      expect(getPayCount()).toBe(1)

      // A third restart after payment must also do nothing for period 0.
      const store3 = new FilePlanStore(storeFile)
      const { client: wraith3, createOrderCalls: orders3 } = makeWraithMock()
      const { payer: payer3, getPayCount: payCount3 } = makePayerMock()
      const runner3 = new RecurringTopupRunner({
        store: store3,
        wraith: wraith3,
        payer: payer3,
        now: () => clock + 120_000,
        logger: {},
      })
      const afterSecondRestart = await runner3.runDuePlans(clock + 120_000)
      expect(afterSecondRestart).toEqual([])
      expect(orders3).toHaveLength(0)
      expect(payCount3()).toBe(0)

      const plansAfter = await runner3.listPlans(WALLET_CONTRACT)
      expect(plansAfter[0].id).toBe(plan.id)
      expect(plansAfter[0].paidCount).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stops cleanly when allowance cannot cover next payment: submits nothing, does not retry, explains what was and was not paid', async () => {
    const store = new InMemoryPlanStore()
    const { client: wraith, createOrderCalls } = makeWraithMock()
    // 500 NGN at 1600 NGN/USDC = 0.3125 USDC = 3_125_000 base units.
    // Give enough for 1 payment (4_000_000) so period 0 succeeds and period 1 is short.
    const { payer, getPayCount } = makePayerMock({ initialAllowance: 4_000_000n })
    let clock = Date.parse('2026-11-19T10:00:00.000Z')

    const runner = new RecurringTopupRunner({
      store,
      wraith,
      payer,
      now: () => clock,
      logger: {},
    })

    const plan = await runner.createPlan({
      walletAddress: WALLET_CONTRACT,
      refundAddress: REFUND_ACCOUNT,
      spenderAddress: SPENDER_ACCOUNT,
      tokenContractId: USDC_SAC_CONTRACT,
      customerRef: CUSTOMER_REF,
      category: 'airtime',
      provider: 'MTN',
      phoneNumber: PHONE_RAW,
      amountNgn: 500,
      coin: 'usdc',
      frequency: 'weekly',
      totalPeriods: 4,
      startAt: new Date(clock).toISOString(),
    })

    // Period 0 succeeds.
    const p0 = await runner.runDuePlans(clock)
    expect(p0[0].action).toBe('delivered')
    expect(createOrderCalls).toHaveLength(1)
    expect(getPayCount()).toBe(1)

    // Advance 1 week to Period 1 — remaining allowance is 875_000 < 3_125_000.
    clock += 7 * 24 * 60 * 60 * 1000
    const p1 = await runner.runDuePlans(clock)
    expect(p1).toHaveLength(1)
    expect(p1[0].action).toBe('stopped_allowance')
    expect(p1[0].stopReason).toBe('allowance_insufficient')

    // CRITICAL: Nothing was submitted to wraith or Stellar for Period 1!
    expect(createOrderCalls).toHaveLength(1)
    expect(getPayCount()).toBe(1)

    // Plan is stopped, does not retry on future ticks, and tells user why + what was/was not paid.
    const [updated] = await runner.listPlans(WALLET_CONTRACT)
    expect(updated.id).toBe(plan.id)
    expect(updated.status).toBe('stopped')
    expect(updated.stopReason).toBe('allowance_insufficient')
    expect(updated.nextDueAt).toBeNull()
    expect(updated.stopMessage).toContain('remaining allowance could not cover the next payment')
    expect(updated.stopMessage).toContain('Paid: 1 of 4 periods')
    expect(updated.stopMessage).toContain(FULL_TX_HASH_1)
    expect(updated.stopMessage).toContain('Not paid: 3 remaining periods')

    // Future tick must not retry.
    const later = await runner.runDuePlans(clock + 7 * 24 * 60 * 60 * 1000)
    expect(later).toEqual([])
    expect(createOrderCalls).toHaveLength(1)
    expect(getPayCount()).toBe(1)
  })

  it('recognises expired and revoked (mainnet STOP_REPLACEMENT) allowances per ccebd01a', () => {
    const expiry = 1_700_000_000n
    // Within 60s clock skew tolerance: still valid
    expect(evaluateAllowance({ amount: 5_000_000n, expiry }, 3_125_000n, expiry + EXPIRY_TOLERANCE_SECS).ok).toBe(true)
    // Past 60s tolerance: expired
    const expired = evaluateAllowance({ amount: 5_000_000n, expiry }, 3_125_000n, expiry + EXPIRY_TOLERANCE_SECS + 1n)
    expect(expired.ok).toBe(false)
    if (!expired.ok) expect(expired.reason).toBe('allowance_expired')

    // Mainnet STOP_REPLACEMENT (amount=1, expiry=1): revoked
    const stopped = evaluateAllowance({ amount: 1n, expiry: 1n }, 3_125_000n, expiry)
    expect(stopped.ok).toBe(false)
    if (!stopped.ok) expect(stopped.reason).toBe('allowance_revoked')

    // Used up (amount=0)
    const usedUp = evaluateAllowance({ amount: 0n, expiry: null }, 3_125_000n, expiry)
    expect(usedUp.ok).toBe(false)
    if (!usedUp.ok) expect(usedUp.reason).toBe('allowance_used_up')
  })

  it('records an order that fails after payment and never pays again for that period', async () => {
    const store = new InMemoryPlanStore()
    const { client: wraith, createOrderCalls } = makeWraithMock({
      getBillStatus: jest.fn(async (customerRef: string, orderId: string) => ({
        orderId,
        customerRef,
        status: 'failed',
        billCategory: 'airtime',
        amountNgn: 500,
        amountStableCoin: 0.3125,
        wallet: DEPOSIT_ACCOUNT,
      })),
    })
    const { payer, getPayCount } = makePayerMock()
    const clock = Date.parse('2026-11-19T10:00:00.000Z')

    const runner = new RecurringTopupRunner({
      store,
      wraith,
      payer,
      now: () => clock,
      logger: {},
    })

    await runner.createPlan({
      walletAddress: WALLET_CONTRACT,
      refundAddress: REFUND_ACCOUNT,
      spenderAddress: SPENDER_ACCOUNT,
      tokenContractId: USDC_SAC_CONTRACT,
      customerRef: CUSTOMER_REF,
      category: 'airtime',
      provider: 'MTN',
      phoneNumber: PHONE_RAW,
      amountNgn: 500,
      coin: 'usdc',
      frequency: 'weekly',
      totalPeriods: 2,
      startAt: new Date(clock).toISOString(),
    })

    const res = await runner.runDuePlans(clock)
    expect(res).toHaveLength(1)
    expect(res[0].action).toBe('failed_after_payment')
    expect(res[0].txHash).toBe(FULL_TX_HASH_1)
    expect(createOrderCalls).toHaveLength(1)
    expect(getPayCount()).toBe(1)

    // Retry at same timestamp must NOT pay again for period 0!
    const retry = await runner.runDuePlans(clock + 1000)
    expect(retry).toEqual([])
    expect(createOrderCalls).toHaveLength(1)
    expect(getPayCount()).toBe(1)

    const [plan] = await runner.listPlans(WALLET_CONTRACT)
    expect(plan.failedAfterPaymentCount).toBe(1)
    expect(plan.periods[0].status).toBe('failed_after_payment')
    expect(plan.periods[0].txHash).toBe(FULL_TX_HASH_1)
    expect(plan.periods[0].errorMessage).toContain('will not be paid again')

    // Still shown in activity with full tx hash and failure note.
    const activity = await runner.getActivityForWallet(WALLET_CONTRACT)
    expect(activity).toHaveLength(1)
    expect(activity[0].status).toBe('failed_after_payment')
    expect(activity[0].txHash).toBe(FULL_TX_HASH_1)
  })

  it('rejects NIN in plan creation and scrubs phone numbers and NIN from logs', async () => {
    const store = new InMemoryPlanStore()
    const { client: wraith } = makeWraithMock()
    const { payer } = makePayerMock()
    const runner = new RecurringTopupRunner({ store, wraith, payer, logger: {} })

    await expect(
      runner.createPlan({
        walletAddress: WALLET_CONTRACT,
        refundAddress: REFUND_ACCOUNT,
        spenderAddress: SPENDER_ACCOUNT,
        tokenContractId: USDC_SAC_CONTRACT,
        customerRef: CUSTOMER_REF,
        category: 'airtime',
        provider: 'MTN',
        phoneNumber: PHONE_RAW,
        amountNgn: 500,
        frequency: 'weekly',
        totalPeriods: 4,
        ...({ nin: '12345678901' } as Record<string, unknown>),
      }),
    ).rejects.toThrow(/NIN must never/)

    const scrubbed = scrubLogMessage(
      `topup failed for ${PHONE_RAW} and +2348031234567 with nin: 12345678901`,
      [PHONE_RAW],
    )
    expect(scrubbed).not.toContain(PHONE_RAW)
    expect(scrubbed).not.toContain('2348031234567')
    expect(scrubbed).not.toContain('12345678901')
  })

  it('supports preparing, listing, and cancelling recurring top-ups in chat via agent tools', async () => {
    const store = new InMemoryPlanStore()
    const { client: wraith } = makeWraithMock()
    const { payer } = makePayerMock()
    const runner = new RecurringTopupRunner({ store, wraith, payer, logger: {} })

    // 1. Prepare plan in chat
    const llmPrepare = scriptedLlm([
      {
        text: '',
        toolCalls: [
          {
            id: 'call_1',
            name: 'prepare_recurring_topup',
            input: {
              category: 'airtime',
              provider: 'MTN',
              phone_number: PHONE_RAW,
              amount_ngn: 500,
              frequency: 'weekly',
              total_periods: 4,
              coin: 'usdc',
            },
          },
        ],
      },
      {
        text: 'Please confirm your weekly ₦500 MTN airtime plan for *******4567 (4 weeks).',
        toolCalls: [],
      },
    ])

    const prepRes = await runAgent(
      'Top up my MTN line 08031234567 with 500 naira every week for 4 weeks',
      WALLET_CONTRACT,
      [],
      REFUND_ACCOUNT,
      undefined,
      llmPrepare,
      { listRecurringPlans: (addr) => runner.listPlans(addr) },
    )

    expect(prepRes.recurringTopupIntent).toEqual({
      category: 'airtime',
      provider: 'MTN',
      maskedPhone: '*******4567',
      phoneNumber: PHONE_RAW,
      amountNgn: 500,
      coin: 'usdc',
      frequency: 'weekly',
      totalPeriods: 4,
    })
    // Tool result sent back to the model must NOT echo the raw phone number.
    expect(llmPrepare.toolResults[0][0].content).not.toContain(PHONE_RAW)
    expect(llmPrepare.toolResults[0][0].content).toContain('*******4567')

    // 2. Confirm plan on server, then list and prepare cancel in chat.
    const saved = await runner.createPlan({
      walletAddress: WALLET_CONTRACT,
      refundAddress: REFUND_ACCOUNT,
      spenderAddress: SPENDER_ACCOUNT,
      tokenContractId: USDC_SAC_CONTRACT,
      customerRef: CUSTOMER_REF,
      category: 'airtime',
      provider: 'MTN',
      phoneNumber: PHONE_RAW,
      amountNgn: 500,
      coin: 'usdc',
      frequency: 'weekly',
      totalPeriods: 4,
    })

    const llmListAndCancel = scriptedLlm([
      {
        text: '',
        toolCalls: [{ id: 'call_2', name: 'list_recurring_topups', input: {} }],
      },
      {
        text: '',
        toolCalls: [{ id: 'call_3', name: 'cancel_recurring_topup', input: { plan_id: saved.id } }],
      },
      {
        text: `Ready to cancel plan ${saved.id}.`,
        toolCalls: [],
      },
    ])

    const cancelRes = await runAgent(
      'Cancel my weekly airtime plan',
      WALLET_CONTRACT,
      [],
      REFUND_ACCOUNT,
      undefined,
      llmListAndCancel,
      { listRecurringPlans: (addr) => runner.listPlans(addr) },
    )

    expect(llmListAndCancel.toolResults[0][0].content).toContain(saved.id)
    expect(llmListAndCancel.toolResults[0][0].content).not.toContain(PHONE_RAW)
    expect(cancelRes.cancelTopupIntent).toEqual({ planId: saved.id })
  })

  it('exposes HTTP endpoints on the agent server to create, list, run, view full-hash activity, and cancel plans', async () => {
    const store = new InMemoryPlanStore()
    const { client: wraith } = makeWraithMock()
    const { payer } = makePayerMock()
    const clock = Date.parse('2026-11-19T10:00:00.000Z')
    const runner = new RecurringTopupRunner({ store, wraith, payer, now: () => clock, logger: {} })

    const server = createAgentServer({
      port: 0,
      autoListen: true,
      accessToken: 'test-token',
      recurringRunner: runner,
      llmProvider: scriptedLlm([{ text: 'ok', toolCalls: [] }]),
    })

    try {
      const addr = server.httpServer.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      const base = `http://127.0.0.1:${port}`

      // Reject NIN over HTTP
      const ninRes = await fetch(`${base}/recurring-topups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress: WALLET_CONTRACT,
          refundAddress: REFUND_ACCOUNT,
          spenderAddress: SPENDER_ACCOUNT,
          tokenContractId: USDC_SAC_CONTRACT,
          customerRef: CUSTOMER_REF,
          category: 'airtime',
          provider: 'MTN',
          phoneNumber: PHONE_RAW,
          amountNgn: 500,
          frequency: 'weekly',
          totalPeriods: 2,
          nin: '12345678901',
        }),
      })
      expect(ninRes.status).toBe(400)

      // Create plan
      const createRes = await fetch(`${base}/recurring-topups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress: WALLET_CONTRACT,
          refundAddress: REFUND_ACCOUNT,
          spenderAddress: SPENDER_ACCOUNT,
          tokenContractId: USDC_SAC_CONTRACT,
          customerRef: CUSTOMER_REF,
          category: 'airtime',
          provider: 'MTN',
          phoneNumber: PHONE_RAW,
          amountNgn: 500,
          coin: 'usdc',
          frequency: 'weekly',
          totalPeriods: 2,
          startAt: new Date(clock).toISOString(),
        }),
      })
      expect(createRes.status).toBe(201)
      const createdBody = (await createRes.json()) as { plan: { id: string; maskedPhone: string } }
      expect(createdBody.plan.maskedPhone).toBe('*******4567')

      // Trigger due tick (requires token when accessToken is configured)
      const unauthorizedTick = await fetch(`${base}/recurring-topups/tick`, { method: 'POST' })
      expect(unauthorizedTick.status).toBe(403)

      const tickRes = await fetch(`${base}/recurring-topups/tick`, {
        method: 'POST',
        headers: { 'x-agent-token': 'test-token' },
      })
      expect(tickRes.status).toBe(200)
      const tickBody = (await tickRes.json()) as { outcomes: Array<{ txHash?: string }> }
      expect(tickBody.outcomes[0].txHash).toBe(FULL_TX_HASH_1)

      // Activity returns full 64-char tx hash
      const actRes = await fetch(
        `${base}/recurring-topups/activity?walletAddress=${encodeURIComponent(WALLET_CONTRACT)}`,
      )
      expect(actRes.status).toBe(200)
      const actBody = (await actRes.json()) as { activity: Array<{ txHash: string }> }
      expect(actBody.activity).toHaveLength(1)
      expect(actBody.activity[0].txHash).toBe(FULL_TX_HASH_1)

      // Cancel plan
      const cancelRes = await fetch(
        `${base}/recurring-topups/${encodeURIComponent(createdBody.plan.id)}/cancel`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ walletAddress: WALLET_CONTRACT }),
        },
      )
      expect(cancelRes.status).toBe(200)
      const cancelBody = (await cancelRes.json()) as { plan: { status: string } }
      expect(cancelBody.plan.status).toBe('cancelled')
    } finally {
      await server.close()
    }
  })
})
