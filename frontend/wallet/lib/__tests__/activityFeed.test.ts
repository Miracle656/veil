/**
 * The shared activity store.
 *
 * This is where a user checks whether a payment actually left. The tests pin
 * newest-first ordering, replay de-duplication, and the fact that nothing is
 * inserted speculatively — a record only exists once the confirmed stream
 * reports it, so a pending payment is never rendered as complete.
 */

// @stellar/stellar-sdk needs these at module load; jsdom omits them.
import { webcrypto } from 'crypto'
import { TextDecoder, TextEncoder } from 'util'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true })
Object.assign(globalThis, { TextEncoder, TextDecoder })

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { Keypair } from '@stellar/stellar-sdk'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { createActivityFeed, type ActivityEvent } from '@veil/events'

import type { TxRecord } from '@/components/TxDetailSheet'

import {
  appendActivityFeed,
  hydrateActivityFeed,
  initActivityFeed,
  stopActivityFeed,
  subscribeActivityFeed,
  useActivityFeed,
} from '../activityFeed'

jest.mock('@veil/events', () => ({
  createActivityFeed: jest.fn(),
}))

jest.mock('../network', () => ({
  getNetwork: jest.fn(() => ({ horizonUrl: 'https://horizon-testnet.stellar.org' })),
}))

const HORIZON_URL = 'https://horizon-testnet.stellar.org'

const mockCreateActivityFeed = createActivityFeed as jest.MockedFunction<typeof createActivityFeed>

type FeedConfig = Parameters<typeof createActivityFeed>[0]

/** Full 56-character Stellar addresses, generated rather than truncated. */
const ACCOUNT = Keypair.random().publicKey()
const OTHER_ACCOUNT = Keypair.random().publicKey()

/** Full 64-character transaction hashes. */
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)

let configs: FeedConfig[] = []
let stops: jest.Mock[] = []
let unsubs: Array<() => void> = []
let counterparty = ''

function remember(unsubscribe: () => void): void {
  unsubs.push(unsubscribe)
}

function event(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: 'op-1',
    type: 'payment_sent',
    amount: '12.5000000',
    asset: 'USDC',
    counterparty,
    timestamp: 1_770_000_000,
    hash: HASH_A,
    ...overrides,
  }
}

function record(overrides: Partial<TxRecord> = {}): TxRecord {
  return {
    id: 'rec-1',
    type: 'sent',
    amount: '1.0000000',
    asset: 'XLM',
    counterparty,
    timestamp: 1_770_000_000,
    hash: HASH_A,
    ...overrides,
  }
}

function watch(): { latest: () => TxRecord[] } {
  let current: TxRecord[] = []
  remember(subscribeActivityFeed((records) => { current = records }))
  return { latest: () => current }
}

function hashes(records: TxRecord[]): string[] {
  return records.map((r) => r.hash ?? '')
}

beforeEach(() => {
  for (const unsubscribe of unsubs) unsubscribe()
  unsubs = []
  stopActivityFeed()
  hydrateActivityFeed([])
  configs = []
  stops = []
  counterparty = Keypair.random().publicKey()
  mockCreateActivityFeed.mockReset()
  mockCreateActivityFeed.mockImplementation((config) => {
    configs.push(config)
    const stop = jest.fn()
    stops.push(stop)
    return { stop }
  })
})

describe('initActivityFeed', () => {
  // Breaks: the stream watches the wrong account or Horizon, so a user's payments never appear.
  it('opens the stream for the requested account and network', () => {
    expect(ACCOUNT).toHaveLength(56)

    initActivityFeed(ACCOUNT)

    expect(mockCreateActivityFeed).toHaveBeenCalledTimes(1)
    expect(configs[0].accountId).toBe(ACCOUNT)
    expect(configs[0].horizonUrl).toBe(HORIZON_URL)
    expect(typeof configs[0].onEvent).toBe('function')
  })

  // Breaks: every dashboard poll opens another stream and the same payment is processed twice.
  it('does not open a second stream for the same account', () => {
    initActivityFeed(ACCOUNT)
    initActivityFeed(ACCOUNT)

    expect(mockCreateActivityFeed).toHaveBeenCalledTimes(1)
  })

  // Breaks: switching wallets leaves the old stream alive and mixes two accounts' histories.
  it('stops the previous stream when the account changes', () => {
    initActivityFeed(ACCOUNT)
    initActivityFeed(OTHER_ACCOUNT)

    expect(stops[0]).toHaveBeenCalledTimes(1)
    expect(mockCreateActivityFeed).toHaveBeenCalledTimes(2)
    expect(configs[1].accountId).toBe(OTHER_ACCOUNT)
  })

  // Breaks: stopping the feed leaves the account pinned, so the next unlock silently reuses a dead stream.
  it('stops the stream and forgets the account on stop', () => {
    initActivityFeed(ACCOUNT)
    stopActivityFeed()

    expect(stops[0]).toHaveBeenCalledTimes(1)

    initActivityFeed(ACCOUNT)

    expect(mockCreateActivityFeed).toHaveBeenCalledTimes(2)
  })
})

describe('streamed events', () => {
  // Breaks: the newest payment is buried below older ones, so a user cannot tell whether their last send went out.
  it('prepends streamed events so the newest payment is first', () => {
    initActivityFeed(ACCOUNT)
    const view = watch()

    configs[0].onEvent(event({ id: 'op-a', hash: HASH_A, timestamp: 100 }))
    configs[0].onEvent(event({ id: 'op-b', hash: HASH_B, timestamp: 200, type: 'payment_received' }))

    expect(hashes(view.latest())).toEqual([HASH_B, HASH_A])
  })

  // Breaks: a swap is rendered as a plain received payment, hiding the asset that was actually bought.
  it('maps sent, received and swap events to the fields the activity rows render', () => {
    initActivityFeed(ACCOUNT)
    const view = watch()

    configs[0].onEvent(event({ id: 'op-sent', hash: HASH_A, type: 'payment_sent' }))
    configs[0].onEvent(
      event({
        id: 'op-swap',
        hash: HASH_B,
        type: 'path_payment',
        amount: '10.0000000',
        asset: 'XLM',
        destAmount: '4.2000000',
        destAsset: 'USDC',
      }),
    )
    configs[0].onEvent(event({ id: 'op-created', hash: HASH_C, type: 'account_created' }))

    const byHash = new Map(view.latest().map((r) => [r.hash, r]))

    expect(byHash.get(HASH_A)).toMatchObject({
      id: 'op-sent',
      type: 'sent',
      amount: '12.5000000',
      asset: 'USDC',
      counterparty,
    })
    expect(byHash.get(HASH_B)).toMatchObject({
      type: 'swapped',
      destAmount: '4.2000000',
      destAsset: 'USDC',
    })
    expect(byHash.get(HASH_C)).toMatchObject({ type: 'received' })
  })

  // Breaks: a reconnect replays the last operation and the payment appears twice, so history overstates spending.
  it('drops a replayed stream event with the same transaction hash', () => {
    initActivityFeed(ACCOUNT)
    const view = watch()

    configs[0].onEvent(event({ id: 'op-1', hash: HASH_A }))
    configs[0].onEvent(event({ id: 'op-1', hash: HASH_A }))

    expect(view.latest()).toHaveLength(1)
  })

  // Breaks: an event that has not closed into a ledger is turned into a completed row before the network confirms it.
  it('adds nothing until the confirmed stream delivers an event', () => {
    initActivityFeed(ACCOUNT)
    const view = watch()

    expect(view.latest()).toEqual([])

    configs[0].onEvent(event({ hash: HASH_A }))

    expect(view.latest()).toHaveLength(1)
  })
})

describe('appendActivityFeed', () => {
  // Breaks: a paged fetch appends the same payment again and the total history overstates spending.
  it('appends only records whose hash is new', () => {
    hydrateActivityFeed([record({ hash: HASH_A, amount: '1.0000000' })])

    appendActivityFeed([record({ id: 'duplicate', hash: HASH_A, amount: '999.0000000' })])

    const view = watch()
    expect(view.latest()).toHaveLength(1)
    expect(view.latest()[0].amount).toBe('1.0000000')
  })

  // Breaks: a newly paged record with an older ledger time jumps to the top, so the feed shows fetch order instead of time order.
  it('sorts appended records by timestamp descending', () => {
    hydrateActivityFeed([record({ hash: HASH_B, timestamp: 200 })])

    appendActivityFeed([
      record({ id: 'rec-a', hash: HASH_A, timestamp: 100 }),
      record({ id: 'rec-c', hash: HASH_C, timestamp: 300 }),
    ])

    expect(hashes(watch().latest())).toEqual([HASH_C, HASH_B, HASH_A])
  })

  // Breaks: an all-duplicate page triggers a re-render and the list flickers without changing.
  it('does not notify subscribers when every appended record is a duplicate', () => {
    hydrateActivityFeed([record({ hash: HASH_A })])

    const listener = jest.fn()
    remember(subscribeActivityFeed(listener))
    listener.mockClear()

    appendActivityFeed([record({ hash: HASH_A })])

    expect(listener).not.toHaveBeenCalled()
  })
})

describe('hydrateActivityFeed', () => {
  // Breaks: a fresh history fetch leaves the previous account's records on screen.
  it('replaces the list with the fetched history', () => {
    hydrateActivityFeed([record({ hash: HASH_A })])
    hydrateActivityFeed([record({ hash: HASH_B, timestamp: 1_770_000_100 })])

    const view = watch()

    expect(hashes(view.latest())).toEqual([HASH_B])
  })

  // Breaks: a component that mounts after the fetch shows an empty feed until the next payment arrives.
  it('emits the current snapshot immediately to a new subscriber', () => {
    hydrateActivityFeed([record({ hash: HASH_A })])

    expect(hashes(watch().latest())).toEqual([HASH_A])
  })

  // Breaks: an unmounted screen keeps receiving updates and holds the whole feed in memory.
  it('stops notifying after unsubscribe', () => {
    const listener = jest.fn()
    const unsubscribe = subscribeActivityFeed(listener)
    listener.mockClear()

    unsubscribe()
    hydrateActivityFeed([record({ hash: HASH_A })])

    expect(listener).not.toHaveBeenCalled()
  })

  // Breaks: one screen mutating its snapshot corrupts the shared feed for every other screen.
  it('hands each subscriber a copy rather than the internal array', () => {
    hydrateActivityFeed([record({ hash: HASH_A })])

    const first = watch()
    first.latest().push(record({ hash: HASH_B, timestamp: 1_770_000_100 }))

    expect(hashes(watch().latest())).toEqual([HASH_A])
  })
})

describe('empty versus failed load', () => {
  // Breaks: an account with no history cannot be told apart from a feed that never started.
  it('represents an empty feed as an empty snapshot', () => {
    expect(watch().latest()).toEqual([])
  })

  // Breaks: a failure to open the stream is swallowed and the empty list looks like a wallet with no history.
  it('propagates a failure to open the stream instead of showing an empty feed', () => {
    const failure = new Error('Horizon unreachable')
    mockCreateActivityFeed.mockImplementation(() => {
      throw failure
    })

    expect(() => initActivityFeed(ACCOUNT)).toThrow(failure)
  })
})

describe('useActivityFeed', () => {
  // Breaks: the activity screen renders once and never updates when a payment arrives.
  it('re-renders the hook consumer when the store changes', () => {
    const renders: TxRecord[][] = []

    function Probe() {
      renders.push(useActivityFeed())
      return null
    }

    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => {
      root.render(React.createElement(Probe))
    })
    expect(renders[renders.length - 1]).toEqual([])

    const incoming = record({ hash: HASH_B, timestamp: 1_770_000_100 })
    act(() => {
      hydrateActivityFeed([incoming])
    })

    expect(renders[renders.length - 1]).toEqual([incoming])

    act(() => {
      root.unmount()
    })
  })
})
