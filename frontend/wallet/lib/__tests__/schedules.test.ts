/**
 * @jest-environment ./dst-test-environment.js
 *
 * The schedule store and the next-run arithmetic.
 *
 * A schedule moves money with nobody watching, so a wrong row filter or a
 * drifting next_run is not noticed until several payments have already gone
 * out (or failed to). These tests pin the query shape, the empty-vs-failed
 * distinction, and the wall-clock behaviour of a cadence across month and
 * daylight-saving boundaries.
 *
 * The pinned environment is America/New_York: a DST zone whose offset differs
 * between the winter and summer dates used here.
 */

// @stellar/stellar-sdk needs these at module load; jsdom omits them.
import { webcrypto } from 'crypto'
import { TextDecoder, TextEncoder } from 'util'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true })
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { Keypair } from '@stellar/stellar-sdk'

import {
  advanceNextRun,
  createSchedule,
  deleteSchedule,
  getDueSchedules,
  getSchedules,
  updateSchedule,
  type PaymentSchedule,
} from '../schedules'
import { supabase } from '../supabase'

jest.mock('../supabase', () => ({
  supabase: { from: jest.fn() },
}))

const from = supabase.from as unknown as jest.Mock

/** Full 56-character Stellar addresses, generated rather than truncated. */
const OWNER = Keypair.random().publicKey()
const DEST = Keypair.random().publicKey()

interface QueryResult {
  data?: unknown
  error?: unknown
}

interface QueryChain {
  insert: jest.Mock
  update: jest.Mock
  delete: jest.Mock
  select: jest.Mock
  eq: jest.Mock
  order: jest.Mock
  lte: jest.Mock
  single: jest.Mock
  then: (
    onFulfilled: (value: QueryResult) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise<unknown>
}

/**
 * A Supabase builder stand-in. Every filter returns the chain; awaiting the
 * chain (or calling .single()) yields the configured result, which is how
 * Postgrest behaves.
 */
function makeQuery(result: QueryResult): QueryChain {
  const chain = {} as QueryChain
  for (const method of ['insert', 'update', 'delete', 'select', 'eq', 'order', 'lte'] as const) {
    chain[method] = jest.fn(() => chain)
  }
  chain.single = jest.fn(() => Promise.resolve(result))
  chain.then = (onFulfilled, onRejected) =>
    Promise.resolve(result).then(onFulfilled, onRejected)
  return chain
}

const SCHEDULE: Omit<PaymentSchedule, 'id'> = {
  owner: OWNER,
  dest: DEST,
  asset: 'USDC',
  amount: '25.0000000',
  cadence: 'monthly',
  next_run: '2026-02-15T09:00:00.000Z',
  status: 'active',
}

const NOW = '2026-02-15T09:00:00.000Z'

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers()
  jest.setSystemTime(new Date(NOW))
})

afterEach(() => {
  jest.useRealTimers()
})

describe('createSchedule', () => {
  // Breaks: a schedule is stored without its owner or amount, so the backend executes a row the wallet cannot recognise.
  it('inserts the exact schedule and returns the stored row', async () => {
    const stored: PaymentSchedule = { id: 'sched-1', ...SCHEDULE }
    const chain = makeQuery({ data: stored, error: null })
    from.mockReturnValue(chain)

    await expect(createSchedule(SCHEDULE)).resolves.toBe(stored)

    expect(from).toHaveBeenCalledWith('payment_schedules')
    expect(chain.insert).toHaveBeenCalledWith([SCHEDULE])
    expect(chain.select).toHaveBeenCalledTimes(1)
    expect(chain.single).toHaveBeenCalledTimes(1)
  })

  // Breaks: an insert failure is swallowed and the caller reports a schedule that was never saved.
  it('rethrows the database error instead of returning a phantom schedule', async () => {
    const dbError = new Error('insert failed')
    from.mockReturnValue(makeQuery({ data: null, error: dbError }))

    await expect(createSchedule(SCHEDULE)).rejects.toBe(dbError)
  })
})

describe('getSchedules', () => {
  // Breaks: one wallet sees another owner's schedules, or the next payment is not the first row shown.
  it('filters by owner and orders by the next run ascending', async () => {
    const rows: PaymentSchedule[] = [{ id: 1, ...SCHEDULE }]
    const chain = makeQuery({ data: rows, error: null })
    from.mockReturnValue(chain)

    await expect(getSchedules(OWNER)).resolves.toBe(rows)

    expect(chain.select).toHaveBeenCalledWith('*')
    expect(chain.eq).toHaveBeenCalledWith('owner', OWNER)
    expect(chain.order).toHaveBeenCalledWith('next_run', { ascending: true })
  })

  // Breaks: a wallet that has never scheduled a payment is shown as a failed load.
  it('returns an empty array when the owner has no schedules', async () => {
    from.mockReturnValue(makeQuery({ data: null, error: null }))

    await expect(getSchedules(OWNER)).resolves.toEqual([])
  })

  // Breaks: a failed read is shown as "no schedules", hiding payments that still exist on the backend.
  it('rethrows a failed read instead of reporting an empty list', async () => {
    const dbError = new Error('select failed')
    from.mockReturnValue(makeQuery({ data: null, error: dbError }))

    await expect(getSchedules(OWNER)).rejects.toBe(dbError)
  })
})

describe('deleteSchedule', () => {
  // Breaks: the delete is sent without the row id and removes more than the one schedule the user chose.
  it('deletes by id and resolves without a payload', async () => {
    const chain = makeQuery({ data: null, error: null })
    from.mockReturnValue(chain)

    await expect(deleteSchedule('sched-1')).resolves.toBeUndefined()

    expect(from).toHaveBeenCalledWith('payment_schedules')
    expect(chain.delete).toHaveBeenCalledTimes(1)
    expect(chain.eq).toHaveBeenCalledWith('id', 'sched-1')
  })

  // Breaks: a failed delete looks successful and the schedule keeps paying after the user removed it.
  it('rethrows a failed delete', async () => {
    const dbError = new Error('delete failed')
    from.mockReturnValue(makeQuery({ data: null, error: dbError }))

    await expect(deleteSchedule('sched-1')).rejects.toBe(dbError)
  })
})

describe('updateSchedule', () => {
  // Breaks: an edit applies to the wrong row or returns a stale record the UI then displays as saved.
  it('updates by id and returns the updated row', async () => {
    const updated: PaymentSchedule = { id: 'sched-1', ...SCHEDULE, amount: '40.0000000' }
    const chain = makeQuery({ data: updated, error: null })
    from.mockReturnValue(chain)

    await expect(updateSchedule('sched-1', { amount: '40.0000000' })).resolves.toBe(updated)

    expect(from).toHaveBeenCalledWith('payment_schedules')
    expect(chain.update).toHaveBeenCalledWith({ amount: '40.0000000' })
    expect(chain.eq).toHaveBeenCalledWith('id', 'sched-1')
    expect(chain.single).toHaveBeenCalledTimes(1)
  })

  // Breaks: a failed pause is displayed as saved and the next run keeps taking money.
  it('rethrows a failed update', async () => {
    const dbError = new Error('update failed')
    from.mockReturnValue(makeQuery({ data: null, error: dbError }))

    await expect(updateSchedule('sched-1', { status: 'paused' })).rejects.toBe(dbError)
  })
})

describe('getDueSchedules', () => {
  // Breaks: paused or future schedules are executed now, moving money before the user asked for it.
  it('asks only for active schedules due at or before now', async () => {
    const rows: PaymentSchedule[] = [{ id: 1, ...SCHEDULE }]
    const chain = makeQuery({ data: rows, error: null })
    from.mockReturnValue(chain)

    await expect(getDueSchedules(OWNER)).resolves.toBe(rows)

    expect(chain.eq).toHaveBeenCalledWith('owner', OWNER)
    expect(chain.eq).toHaveBeenCalledWith('status', 'active')
    expect(chain.lte).toHaveBeenCalledWith('next_run', NOW)
  })

  // Breaks: a wallet whose schedules are all in the future is shown as a failed load each time it opens.
  it('returns an empty array when nothing is due', async () => {
    from.mockReturnValue(makeQuery({ data: null, error: null }))

    await expect(getDueSchedules(OWNER)).resolves.toEqual([])
  })

  // Breaks: a failed due-query is shown as "nothing due", so a missed payment is invisible until the next check.
  it('rethrows a failed due-query instead of reporting nothing due', async () => {
    const dbError = new Error('due query failed')
    from.mockReturnValue(makeQuery({ data: null, error: dbError }))

    await expect(getDueSchedules(OWNER)).rejects.toBe(dbError)
  })
})

describe('advanceNextRun', () => {
  // Breaks: a daily payment runs twice in one day or skips a day, depending on which way the arithmetic is wrong.
  it('adds one day for a daily cadence', () => {
    expect(advanceNextRun('daily', '2026-02-15T09:00:00.000Z')).toBe('2026-02-16T09:00:00.000Z')
  })

  // Breaks: a weekly payment drifts onto a different weekday every week.
  it('adds seven days for a weekly cadence', () => {
    expect(advanceNextRun('weekly', '2026-02-15T09:00:00.000Z')).toBe('2026-02-22T09:00:00.000Z')
  })

  // Breaks: a monthly payment repeats inside the same month instead of moving to the next one.
  it('moves to the same day of the next month', () => {
    expect(advanceNextRun('monthly', '2026-01-15T09:00:00.000Z')).toBe('2026-02-15T09:00:00.000Z')
  })

  // Breaks: a December schedule stops at the year boundary instead of continuing into January.
  it('crosses a year boundary on a monthly cadence', () => {
    expect(advanceNextRun('monthly', '2026-12-15T09:00:00.000Z')).toBe('2027-01-15T09:00:00.000Z')
  })

  // Breaks: an unrecognised cadence stops the schedule forever instead of falling back to the documented daily default.
  it('falls back to one day for an unknown cadence', () => {
    expect(advanceNextRun('fortnightly', '2026-02-15T09:00:00.000Z')).toBe('2026-02-16T09:00:00.000Z')
  })

  // Breaks: a corrupted next_run becomes an invalid date and the schedule is never due again.
  it('returns the current time when the stored next run cannot be parsed', () => {
    expect(advanceNextRun('daily', 'not-a-date')).toBe(NOW)
  })

  // Breaks: three days of missed daily runs collapse into one, so the payments that were due are silently skipped.
  it('advances from the scheduled time so a missed run stays due until caught up', () => {
    jest.setSystemTime(new Date('2026-02-18T09:00:00.000Z'))

    const next = advanceNextRun('daily', '2026-02-15T09:00:00.000Z')

    expect(next).toBe('2026-02-16T09:00:00.000Z')
    expect(new Date(next).getTime()).toBeLessThan(Date.now())
  })
})

describe('advanceNextRun across a daylight-saving change', () => {

  // Breaks: a 9am daily payment becomes 10am after spring-forward because the code adds 24 UTC hours instead of one local day.
  it('keeps the local wall-clock time on the spring-forward day', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/New_York')

    // 2026-03-07 09:00 America/New_York (EST, UTC-5)
    const next = advanceNextRun('daily', '2026-03-07T14:00:00.000Z')

    // 2026-03-08 09:00 America/New_York (EDT, UTC-4) — one local day later, 23 hours of UTC.
    expect(next).toBe('2026-03-08T13:00:00.000Z')
    expect(new Date(next).getTime() - new Date('2026-03-07T14:00:00.000Z').getTime()).toBe(
      23 * 60 * 60 * 1000,
    )
  })

  // Breaks: a 9am payment becomes 8am after fall-back because the code assumes every local day is 24 UTC hours.
  it('keeps the local wall-clock time on the fall-back day', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/New_York')

    // 2026-10-31 09:00 America/New_York (EDT, UTC-4)
    const next = advanceNextRun('daily', '2026-10-31T13:00:00.000Z')

    // 2026-11-01 09:00 America/New_York (EST, UTC-5) — one local day later, 25 hours of UTC.
    expect(next).toBe('2026-11-01T14:00:00.000Z')
    expect(new Date(next).getTime() - new Date('2026-10-31T13:00:00.000Z').getTime()).toBe(
      25 * 60 * 60 * 1000,
    )
  })
})
