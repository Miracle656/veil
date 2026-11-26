/**
 * @jest-environment jsdom
 *
 * Tests for the private-transaction cost helpers (`lib/privacy/sponsoredSubmit.ts`, #1211).
 *
 * `docs/PRIVACY_COST.md` §2 quotes a fee median and an instruction ceiling, and
 * every public statement about what privacy costs repeats them. These tests pin
 * the code those figures come from: a known set of transactions in, the exact
 * median out; no figure at all from an empty sample; and a third-party RPC that
 * fails or answers part of the question is reported as such, never as a full
 * window.
 *
 * Transactions are real XDR built with the SDK, so the envelope and result
 * parsing is exercised as it runs against the chain. RPC is a plain object (for
 * the sampler) or a spy on `rpc.Server` (for submission) — nothing here touches
 * the network. The live run lives in `sponsoredSubmit.live.test.ts`.
 */

import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

// jsdom provides neither WebCrypto nor these encoders; @stellar/stellar-sdk
// needs them at import time.
Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
  writable: true,
})
Object.assign(globalThis, { TextEncoder, TextDecoder })

jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }), { virtual: true })

// Submission is tested for what happens after the fee bump is built; building
// and signing it is `feeBump.test.ts`'s job.
jest.mock('../../feeBump', () => ({
  buildSponsoredFeeBumpTransaction: jest.fn(() => ({ kind: 'fee-bump' })),
}))

// Below the polyfills on purpose: the SDK reads crypto/TextEncoder while it is
// being imported.
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  rpc as SorobanRpc,
  xdr,
} from '@stellar/stellar-sdk'
import * as Sentry from '@sentry/nextjs'

import { setSentryOptIn } from '../../sentry'
import { getSppConfig } from '../config'
import {
  formatPoolCostReport,
  isPoolTransact,
  readTransactionCost,
  samplePrivateTransactionCosts,
  submitPrivateTransaction,
  summarizeCosts,
  type PoolCostRpc,
} from '../sponsoredSubmit'

// Real contract ids, read from the pinned config rather than re-typed.
const SPP = getSppConfig('testnet')!
const POOL = SPP.pools[0].id
const TRACEABLE_POOL = SPP.pools[1].id
const POOLS = SPP.pools.map((pool) => pool.id)
// A real SPP contract that is not a pool: calls to it must not be sampled.
const NOT_A_POOL = SPP.publicKeyRegistry

const SOURCE = Keypair.random()
const SPONSOR = Keypair.random()
const { SUCCESS, FAILED, NOT_FOUND } = SorobanRpc.Api.GetTransactionStatus

const hash = (n: number) => n.toString(16).padStart(64, '0')

/** An envelope invoking `fn` on `contract`, declaring `instructions` CPU. */
function invocation({
  contract = POOL,
  fn = 'transact',
  instructions = 82_500_000,
  feeBump = false,
}: { contract?: string; fn?: string; instructions?: number; feeBump?: boolean } = {}) {
  const tx = new TransactionBuilder(new Account(SOURCE.publicKey(), '1'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.invokeContractFunction({ contract, function: fn, args: [] }))
    .setSorobanData(new SorobanDataBuilder().setResources(instructions, 0, 0).build())
    .setTimeout(0)
    .build()
  if (!feeBump) return tx.toEnvelope()
  return TransactionBuilder.buildFeeBumpTransaction(SPONSOR, '200', tx, Networks.TESTNET).toEnvelope()
}

/** A classic payment: no Soroban data, no contract call. */
function payment() {
  return new TransactionBuilder(new Account(SOURCE.publicKey(), '1'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: SPONSOR.publicKey(),
        asset: Asset.native(),
        amount: '1',
      })
    )
    .setTimeout(0)
    .build()
    .toEnvelope()
}

function txResult(feeCharged: number) {
  return new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString(String(feeCharged)),
    result: xdr.TransactionResultResult.txSuccess([]),
    ext: new xdr.TransactionResultExt(0),
  })
}

/** A getTransaction answer for a confirmed transaction. */
function confirmed(
  envelopeXdr: xdr.TransactionEnvelope,
  feeCharged: number,
  status: SorobanRpc.Api.GetTransactionStatus = SUCCESS
) {
  return { status, envelopeXdr, resultXdr: txResult(feeCharged) } as unknown as SorobanRpc.Api.GetTransactionResponse
}

/** An RPC events cursor pointing at `ledger` (the ledger is the TOID's top 32 bits). */
const cursorAt = (ledger: number) =>
  `${(BigInt(ledger) << BigInt(32)).toString().padStart(19, '0')}-4294967295`

/** One getEvents page. */
const page = (txHashes: string[], reachedLedger: number, latestLedger = 1_000) => ({
  events: txHashes.map((txHash) => ({ txHash })),
  cursor: cursorAt(reachedLedger),
  latestLedger,
})

function fakeRpc(
  pages: Array<ReturnType<typeof page> | Error>,
  transactions: Record<string, SorobanRpc.Api.GetTransactionResponse | Error>
) {
  const queue = [...pages]
  return {
    getHealth: jest.fn(async () => ({ latestLedger: 1_000, oldestLedger: 100 })),
    getEvents: jest.fn(async (_request: SorobanRpc.Api.GetEventsRequest) => {
      const next = queue.shift()
      if (!next) throw new Error('unexpected extra events page')
      if (next instanceof Error) throw next
      return next
    }),
    getTransaction: jest.fn(async (txHash: string) => {
      const answer = transactions[txHash]
      if (answer === undefined) {
        return { status: NOT_FOUND } as SorobanRpc.Api.GetTransactionResponse
      }
      if (answer instanceof Error) throw answer
      return answer
    }),
  } satisfies PoolCostRpc
}

beforeEach(() => {
  jest.clearAllMocks()
  localStorage.clear()
})

describe('summarizeCosts — the median the document quotes', () => {
  it('returns the exact median, min and max of an odd-sized set', () => {
    // Fees in stroops, out of order. If this breaks, §2's median is wrong.
    expect(summarizeCosts([174_000, 160_000, 220_000, 171_500, 180_000])).toEqual({
      count: 5,
      min: 160_000,
      max: 220_000,
      median: 174_000,
    })
  })

  it('takes the mean of the two middle values for an even-sized set', () => {
    // Picking either middle value instead would bias the published median.
    expect(summarizeCosts([160_000, 174_001, 174_000, 220_000])).toEqual({
      count: 4,
      min: 160_000,
      max: 220_000,
      median: 174_000.5,
    })
  })

  it('sorts numerically, not as strings', () => {
    // Default Array#sort would put 1_000_000 before 200_000.
    expect(summarizeCosts([200_000, 1_000_000, 300_000])?.median).toBe(300_000)
  })

  it('returns no figure for an empty sample', () => {
    // A 0 here would publish "private transactions are free".
    expect(summarizeCosts([])).toBeNull()
  })

  it('keeps a sample of zero cost distinguishable from no sample', () => {
    expect(summarizeCosts([0])).toEqual({ count: 1, min: 0, max: 0, median: 0 })
  })

  it('does not reorder the caller’s array', () => {
    const values = [3, 1, 2]
    summarizeCosts(values)
    expect(values).toEqual([3, 1, 2])
  })

  it('rejects a measurement that is not a finite, non-negative number', () => {
    // NaN breaks the sort silently and would yield an arbitrary "median".
    expect(() => summarizeCosts([1, Number.NaN])).toThrow(RangeError)
    expect(() => summarizeCosts([1, -1])).toThrow(RangeError)
  })
})

describe('readTransactionCost / isPoolTransact — reading one transaction', () => {
  it('reads the charged fee and declared instructions of a plain envelope', () => {
    expect(readTransactionCost({ envelopeXdr: invocation(), resultXdr: txResult(174_000) })).toEqual({
      feeChargedStroops: 174_000,
      instructions: 82_500_000,
    })
  })

  it('reads through a fee bump to the inner transaction’s Soroban data', () => {
    // Sponsored submissions are fee bumps; the instruction count lives on the inner tx.
    const envelopeXdr = invocation({ feeBump: true, instructions: 40_000_000 })
    expect(readTransactionCost({ envelopeXdr, resultXdr: txResult(200_000) })).toEqual({
      feeChargedStroops: 200_000,
      instructions: 40_000_000,
    })
  })

  it('reports no instruction count for a transaction without Soroban data', () => {
    expect(readTransactionCost({ envelopeXdr: payment(), resultXdr: txResult(100) })).toEqual({
      feeChargedStroops: 100,
      instructions: null,
    })
  })

  it('returns null when the answer has no result to read a fee from', () => {
    const partial = { envelopeXdr: invocation() } as Parameters<typeof readTransactionCost>[0]
    expect(readTransactionCost(partial)).toBeNull()
  })

  it('recognises `transact` on any of the pools, plain or fee-bumped', () => {
    expect(isPoolTransact(invocation({ contract: POOL }), POOLS)).toBe(true)
    expect(isPoolTransact(invocation({ contract: TRACEABLE_POOL, feeBump: true }), POOLS)).toBe(true)
  })

  it('does not count other functions, other contracts or classic operations', () => {
    // Each of these would put a non-private-transaction fee into the median.
    expect(isPoolTransact(invocation({ fn: 'register' }), POOLS)).toBe(false)
    expect(isPoolTransact(invocation({ contract: NOT_A_POOL }), POOLS)).toBe(false)
    expect(isPoolTransact(payment(), POOLS)).toBe(false)
  })
})

describe('samplePrivateTransactionCosts — sampling a live pool', () => {
  it('turns a known set of pool transactions into the exact median', async () => {
    const rpc = fakeRpc(
      [
        // A full page (limit 3): the scan must continue even though it is not at the tip.
        page([hash(1), hash(1), hash(2)], 400),
        // A short page below the tip: RPC scans a bounded range per request, so continue.
        page([hash(3)], 700),
        // Short and at the tip: done.
        page([hash(4), hash(5)], 1_000),
      ],
      {
        [hash(1)]: confirmed(invocation({ instructions: 80_000_000 }), 174_000),
        [hash(2)]: confirmed(invocation({ contract: TRACEABLE_POOL, instructions: 82_500_000 }), 160_000),
        [hash(3)]: confirmed(invocation({ feeBump: true, instructions: 70_000_000 }), 220_000),
        // A failed transact: §2 measures successful calls only.
        [hash(4)]: confirmed(invocation(), 999_999, FAILED),
        // A pool event from a call that is not `transact`.
        [hash(5)]: confirmed(invocation({ fn: 'register' }), 888_888),
      }
    )

    const sample = await samplePrivateTransactionCosts({ rpc, poolContractIds: POOLS, pageLimit: 3 })

    expect(sample.fee).toEqual({ count: 3, min: 160_000, max: 220_000, median: 174_000 })
    expect(sample.instructions).toEqual({ count: 3, min: 70_000_000, max: 82_500_000, median: 80_000_000 })
    // hash(1) emitted three events; it is one transaction and is counted once.
    expect(sample).toMatchObject({
      seen: 5,
      sampled: 3,
      excluded: 2,
      unavailable: 0,
      complete: true,
      errors: [],
      fromLedger: 220, // oldest retained ledger (100) plus the safety margin
      toLedger: 1_000,
    })

    expect(rpc.getEvents).toHaveBeenNthCalledWith(1, {
      filters: [{ type: 'contract', contractIds: POOLS }],
      startLedger: 220,
      limit: 3,
    })
    expect(rpc.getEvents).toHaveBeenNthCalledWith(2, {
      filters: [{ type: 'contract', contractIds: POOLS }],
      cursor: cursorAt(400),
      limit: 3,
    })
    expect(rpc.getTransaction).toHaveBeenCalledTimes(5)
  })

  it('uses an explicit start ledger without asking RPC for its retention window', async () => {
    const rpc = fakeRpc([page([], 1_000)], {})
    const sample = await samplePrivateTransactionCosts({ rpc, poolContractIds: [POOL], startLedger: 500 })

    expect(rpc.getHealth).not.toHaveBeenCalled()
    expect(rpc.getEvents.mock.calls[0][0]).toMatchObject({ startLedger: 500 })
    expect(sample.fromLedger).toBe(500)
  })

  it('reports no figure, not zero, when the pool had no private transactions', async () => {
    // What the current testnet pools actually return for some 7-day windows.
    const rpc = fakeRpc([page([], 600), page([], 1_000)], {})
    const sample = await samplePrivateTransactionCosts({ rpc, poolContractIds: POOLS })

    expect(sample.fee).toBeNull()
    expect(sample.instructions).toBeNull()
    expect(sample).toMatchObject({ seen: 0, sampled: 0, complete: true })
    expect(formatPoolCostReport(sample)).toContain('no figure')
    expect(formatPoolCostReport(sample)).not.toMatch(/\bmedian\b/)
  })

  it('reports no figure when every transaction it saw was excluded', async () => {
    const rpc = fakeRpc([page([hash(1)], 1_000)], {
      [hash(1)]: confirmed(invocation(), 174_000, FAILED),
    })
    const sample = await samplePrivateTransactionCosts({ rpc, poolContractIds: POOLS })

    expect(sample.fee).toBeNull()
    expect(sample).toMatchObject({ seen: 1, sampled: 0, excluded: 1, complete: true })
  })

  it('rejects when the very first events request fails (network error)', async () => {
    // Nothing was read, so there is nothing to report — not an empty "complete" sample.
    const rpc = fakeRpc([new Error('getaddrinfo ENOTFOUND soroban-testnet.stellar.org')], {})
    await expect(samplePrivateTransactionCosts({ rpc, poolContractIds: POOLS })).rejects.toThrow(
      'Could not list pool events: getaddrinfo ENOTFOUND'
    )
    expect(rpc.getTransaction).not.toHaveBeenCalled()
  })

  it('rejects on a non-OK response to the first events request', async () => {
    // The RPC client turns an HTTP 503 into a rejection.
    const rpc = fakeRpc([new Error('Request failed with status code 503')], {})
    await expect(samplePrivateTransactionCosts({ rpc, poolContractIds: POOLS })).rejects.toThrow(
      'status code 503'
    )
  })

  it('rejects when it cannot read the retention window to start from', async () => {
    const rpc = fakeRpc([], {})
    rpc.getHealth.mockRejectedValueOnce(new Error('Request failed with status code 502'))
    await expect(samplePrivateTransactionCosts({ rpc, poolContractIds: POOLS })).rejects.toThrow('502')
  })

  it('flags a sample incomplete when a later events page fails', async () => {
    // RPC answered part of the window: the figure covers only what was read and says so.
    const rpc = fakeRpc([page([hash(1), hash(2)], 500), new Error('socket hang up')], {
      [hash(1)]: confirmed(invocation(), 170_000),
      [hash(2)]: confirmed(invocation(), 180_000),
    })
    const sample = await samplePrivateTransactionCosts({ rpc, poolContractIds: POOLS, pageLimit: 2 })

    expect(sample.fee).toEqual({ count: 2, min: 170_000, max: 180_000, median: 175_000 })
    expect(sample.complete).toBe(false)
    expect(sample.toLedger).toBe(500)
    expect(sample.errors).toEqual(['Events page 2 failed: socket hang up'])
    expect(formatPoolCostReport(sample)).toContain('INCOMPLETE')
  })

  it('flags a sample incomplete when transaction lookups fail or come back empty', async () => {
    const rpc = fakeRpc([page([hash(1), hash(2), hash(3), hash(4)], 1_000)], {
      [hash(1)]: confirmed(invocation(), 174_000),
      [hash(2)]: new Error('Request failed with status code 429'),
      // hash(3) is absent: the fake answers NOT_FOUND.
      [hash(4)]: { status: SUCCESS, envelopeXdr: invocation() } as unknown as SorobanRpc.Api.GetTransactionResponse,
    })
    const sample = await samplePrivateTransactionCosts({ rpc, poolContractIds: POOLS })

    // The one good transaction still counts; the three missing ones are not silently dropped.
    expect(sample.fee).toEqual({ count: 1, min: 174_000, max: 174_000, median: 174_000 })
    expect(sample).toMatchObject({ seen: 4, sampled: 1, unavailable: 3, complete: false })
    expect(sample.errors).toEqual([
      'Transaction lookup failed: Request failed with status code 429',
      'Transaction lookup returned NOT_FOUND for a transaction that emitted a pool event',
      'Transaction lookup returned no result to read a fee from',
    ])
  })

  it('reports no figure and incomplete when every lookup fails', async () => {
    const rpc = fakeRpc([page([hash(1)], 1_000)], { [hash(1)]: new Error('timeout of 30000ms exceeded') })
    const sample = await samplePrivateTransactionCosts({ rpc, poolContractIds: POOLS })

    expect(sample.fee).toBeNull()
    expect(sample.complete).toBe(false)
  })

  it('flags a sample incomplete when the scan hits its page cap before the tip', async () => {
    const rpc = fakeRpc([page([], 300), page([], 500)], {})
    const sample = await samplePrivateTransactionCosts({ rpc, poolContractIds: POOLS, maxPages: 2 })

    expect(sample.complete).toBe(false)
    expect(sample.toLedger).toBe(500)
    expect(sample.errors).toEqual([
      'Event scan stopped after 2 pages, before reaching the latest ledger',
    ])
  })

  it('stops and flags a sample incomplete on a cursor it cannot read', async () => {
    // Without a ledger in the cursor it cannot tell whether the scan reached the tip.
    const rpc = fakeRpc([{ events: [], cursor: 'not-a-cursor', latestLedger: 1_000 }], {})
    const sample = await samplePrivateTransactionCosts({ rpc, poolContractIds: POOLS })

    expect(sample.complete).toBe(false)
    expect(sample.errors).toEqual(['Events page 1 returned an unreadable cursor'])
    expect(rpc.getEvents).toHaveBeenCalledTimes(1)
  })

  it('refuses to sample without a pool to sample', async () => {
    // An empty contract filter would match every contract event on the network.
    await expect(
      samplePrivateTransactionCosts({ rpc: fakeRpc([], {}), poolContractIds: [] })
    ).rejects.toThrow('No pool contract ids')
  })
})

describe('formatPoolCostReport', () => {
  it('prints the figures in the units §2 uses', () => {
    const report = formatPoolCostReport({
      fee: { count: 31, min: 160_000, max: 220_000, median: 174_000 },
      instructions: { count: 31, min: 60_000_000, max: 82_500_000, median: 75_000_000 },
      fromLedger: 220,
      toLedger: 1_000,
      seen: 33,
      sampled: 31,
      excluded: 2,
      unavailable: 0,
      complete: true,
      errors: [],
    })

    expect(report).toBe(
      [
        'Ledgers 220-1000',
        'Fee per private transaction: 0.016-0.022 XLM, median 0.0174 (31 successful transact calls)',
        'CPU per transaction: up to 82500000 instructions',
        'Seen 33, sampled 31, excluded 2, unavailable 0',
      ].join('\n')
    )
  })
})

describe('submitPrivateTransaction', () => {
  const RPC_URL = 'https://soroban-testnet.stellar.org'
  const SENT_HASH = hash(0xabc)
  let sendTransaction: jest.SpyInstance
  let getTransaction: jest.SpyInstance

  beforeEach(() => {
    sendTransaction = jest
      .spyOn(SorobanRpc.Server.prototype, 'sendTransaction')
      .mockResolvedValue({ status: 'PENDING', hash: SENT_HASH } as never)
    getTransaction = jest.spyOn(SorobanRpc.Server.prototype, 'getTransaction')
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  const submit = () =>
    submitPrivateTransaction({
      innerTx: {} as never,
      feePayerSecret: SPONSOR.secret(),
      rpcUrl: RPC_URL,
      networkPassphrase: Networks.TESTNET,
    })

  it('returns the hash once confirmed and, when opted in, records fee and instructions', async () => {
    setSentryOptIn(true)
    getTransaction.mockResolvedValue(confirmed(invocation({ feeBump: true }), 174_000))

    await expect(submit()).resolves.toBe(SENT_HASH)
    // This sample was never sent before #1211: the instruction count was read
    // from a property the SDK's Transaction does not have.
    expect(Sentry.captureMessage).toHaveBeenCalledWith('Private transaction cost sample', {
      level: 'info',
      extra: { feeCharged: '174000', instructions: '82500000' },
    })
  })

  it('sends nothing to diagnostics without the opt-in', async () => {
    getTransaction.mockResolvedValue(confirmed(invocation({ feeBump: true }), 174_000))

    await expect(submit()).resolves.toBe(SENT_HASH)
    expect(Sentry.captureMessage).not.toHaveBeenCalled()
  })

  it('sends no half sample for a transaction without an instruction count', async () => {
    setSentryOptIn(true)
    getTransaction.mockResolvedValue(confirmed(payment(), 100))

    await expect(submit()).resolves.toBe(SENT_HASH)
    expect(Sentry.captureMessage).not.toHaveBeenCalled()
  })

  it('still returns the hash when diagnostics throw', async () => {
    // The payment is confirmed; a telemetry failure must not turn it into an error.
    setSentryOptIn(true)
    ;(Sentry.captureMessage as jest.Mock).mockImplementationOnce(() => {
      throw new Error('sentry down')
    })
    getTransaction.mockResolvedValue(confirmed(invocation(), 174_000))

    await expect(submit()).resolves.toBe(SENT_HASH)
  })

  it('polls past NOT_FOUND until the transaction lands', async () => {
    jest.useFakeTimers()
    getTransaction
      .mockResolvedValueOnce({ status: NOT_FOUND })
      .mockResolvedValueOnce(confirmed(invocation(), 174_000))

    const result = submit()
    await jest.advanceTimersByTimeAsync(1_000)
    await expect(result).resolves.toBe(SENT_HASH)
    expect(getTransaction).toHaveBeenCalledTimes(2)
  })

  it('rejects with the error result when RPC refuses the submission', async () => {
    const errorResult = txResult(100)
    sendTransaction.mockResolvedValue({ status: 'ERROR', hash: SENT_HASH, errorResult })

    await expect(submit()).rejects.toThrow(
      `Private transaction rejected: ${errorResult.toXDR('base64')}`
    )
    expect(getTransaction).not.toHaveBeenCalled()
  })

  it('rejects when RPC refuses the submission without an error result', async () => {
    sendTransaction.mockResolvedValue({ status: 'ERROR', hash: SENT_HASH })
    await expect(submit()).rejects.toThrow('Private transaction rejected: unknown')
  })

  it('rejects when the transaction fails on chain', async () => {
    getTransaction.mockResolvedValue(confirmed(invocation(), 174_000, FAILED))
    await expect(submit()).rejects.toThrow('Private transaction failed: FAILED')
  })

  it('gives up after 30 polls and says to check before retrying', async () => {
    // Retrying blindly after a timeout could pay twice.
    jest.useFakeTimers()
    getTransaction.mockResolvedValue({ status: NOT_FOUND })

    const result = submit()
    const assertion = expect(result).rejects.toThrow('Check its status before retrying')
    await jest.advanceTimersByTimeAsync(30_000)
    await assertion
    expect(getTransaction).toHaveBeenCalledTimes(30)
  })
})
