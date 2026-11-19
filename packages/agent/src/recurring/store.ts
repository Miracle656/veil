import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import type { RecurringTopupPlan } from './types.js'

export interface PlanStore {
  create(plan: RecurringTopupPlan): Promise<void>
  get(planId: string): Promise<RecurringTopupPlan | null>
  listByWallet(walletAddress: string): Promise<RecurringTopupPlan[]>
  listDue(nowMs: number): Promise<RecurringTopupPlan[]>
  save(plan: RecurringTopupPlan): Promise<void>
}

function clonePlan(plan: RecurringTopupPlan): RecurringTopupPlan {
  return {
    ...plan,
    periods: plan.periods.map((p) => ({ ...p })),
  }
}

/**
 * In-memory plan store for tests and ephemeral instances.
 */
export class InMemoryPlanStore implements PlanStore {
  private readonly plans = new Map<string, RecurringTopupPlan>()

  async create(plan: RecurringTopupPlan): Promise<void> {
    if (this.plans.has(plan.id)) {
      throw new Error(`Plan ${plan.id} already exists`)
    }
    this.plans.set(plan.id, clonePlan(plan))
  }

  async get(planId: string): Promise<RecurringTopupPlan | null> {
    const plan = this.plans.get(planId)
    return plan ? clonePlan(plan) : null
  }

  async listByWallet(walletAddress: string): Promise<RecurringTopupPlan[]> {
    return [...this.plans.values()]
      .filter((p) => p.walletAddress === walletAddress)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(clonePlan)
  }

  async listDue(nowMs: number): Promise<RecurringTopupPlan[]> {
    return [...this.plans.values()]
      .filter((p) => {
        if (p.status !== 'active' || !p.nextDueAt) return false
        const dueMs = Date.parse(p.nextDueAt)
        return Number.isFinite(dueMs) && dueMs <= nowMs
      })
      .map(clonePlan)
  }

  async save(plan: RecurringTopupPlan): Promise<void> {
    this.plans.set(plan.id, clonePlan(plan))
  }
}

interface PersistedFileShape {
  version: 1
  plans: RecurringTopupPlan[]
}

/**
 * File-backed plan store that survives server restarts.
 *
 * Uses atomic write-then-rename so a crash mid-write never corrupts persisted
 * plans or loses idempotency records for already-reserved periods.
 */
export class FilePlanStore implements PlanStore {
  private readonly filePath: string
  private plans = new Map<string, RecurringTopupPlan>()

  constructor(filePath: string) {
    this.filePath = filePath
    this.loadFromDisk()
  }

  private loadFromDisk(): void {
    if (!existsSync(this.filePath)) {
      this.plans = new Map()
      return
    }
    const raw = readFileSync(this.filePath, 'utf8').trim()
    if (!raw) {
      this.plans = new Map()
      return
    }
    const parsed = JSON.parse(raw) as Partial<PersistedFileShape>
    const list = Array.isArray(parsed.plans) ? parsed.plans : []
    this.plans = new Map(list.map((p) => [p.id, clonePlan(p)]))
  }

  private flushToDisk(): void {
    const dir = path.dirname(this.filePath)
    mkdirSync(dir, { recursive: true })
    const payload: PersistedFileShape = {
      version: 1,
      plans: [...this.plans.values()],
    }
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(tmpPath, this.filePath)
  }

  async create(plan: RecurringTopupPlan): Promise<void> {
    if (this.plans.has(plan.id)) {
      throw new Error(`Plan ${plan.id} already exists`)
    }
    this.plans.set(plan.id, clonePlan(plan))
    this.flushToDisk()
  }

  async get(planId: string): Promise<RecurringTopupPlan | null> {
    const plan = this.plans.get(planId)
    return plan ? clonePlan(plan) : null
  }

  async listByWallet(walletAddress: string): Promise<RecurringTopupPlan[]> {
    return [...this.plans.values()]
      .filter((p) => p.walletAddress === walletAddress)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(clonePlan)
  }

  async listDue(nowMs: number): Promise<RecurringTopupPlan[]> {
    return [...this.plans.values()]
      .filter((p) => {
        if (p.status !== 'active' || !p.nextDueAt) return false
        const dueMs = Date.parse(p.nextDueAt)
        return Number.isFinite(dueMs) && dueMs <= nowMs
      })
      .map(clonePlan)
  }

  async save(plan: RecurringTopupPlan): Promise<void> {
    this.plans.set(plan.id, clonePlan(plan))
    this.flushToDisk()
  }
}
