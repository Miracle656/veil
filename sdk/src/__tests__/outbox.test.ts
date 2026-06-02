/**
 * Unit tests for the offline transaction outbox.
 *
 * The Stellar SDK is mocked so no real network calls are made; we only need
 * rpc.Api.GetTransactionStatus and TransactionBuilder.fromXDR.
 */

import { TransactionOutbox, type OutboxEntry } from '../outbox'

// ── @stellar/stellar-sdk mock ─────────────────────────────────────────────────

jest.mock('@stellar/stellar-sdk', () => ({
  rpc: {
    Api: {
      GetTransactionStatus: { SUCCESS: 'SUCCESS', NOT_FOUND: 'NOT_FOUND', FAILED: 'FAILED' },
    },
  },
  TransactionBuilder: {
    // The outbox only needs fromXDR to return a truthy "transaction" it can pass
    // to server.sendTransaction (which is itself mocked per-test).
    fromXDR: jest.fn((xdr: string) => ({ __tx: xdr })),
  },
}))

// ── In-memory StorageAdapter ──────────────────────────────────────────────────

function makeStore() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, v) },
    removeItem: (k: string) => { map.delete(k) },
    _map: map,
  }
}

const SUCCESS = { status: 'SUCCESS' }
const NOT_FOUND = { status: 'NOT_FOUND' }
const FAILED = { status: 'FAILED' }

function entryInput(overrides: Partial<{ hash: string; sequence: string; xdr: string }> = {}) {
  return {
    hash: overrides.hash ?? 'hash-1',
    sequence: overrides.sequence ?? '100',
    xdr: overrides.xdr ?? 'AAAA-signed-envelope',
    networkPassphrase: 'Test SDF Network ; September 2015',
  }
}

describe('TransactionOutbox', () => {
  // ── persistence ────────────────────────────────────────────────────────────

  describe('persistence', () => {
    it('persists a queued transaction across a "reload" (new instance, same store)', async () => {
      const store = makeStore()
      const outbox = new TransactionOutbox(store)
      await outbox.enqueue(entryInput())

      // Simulate reload: a brand-new outbox reading the same backing store.
      const reloaded = new TransactionOutbox(store)
      const pending = await reloaded.pending()
      expect(pending).toHaveLength(1)
      expect(pending[0].hash).toBe('hash-1')
      expect(pending[0].status).toBe('pending')
    })

    it('deduplicates enqueue by hash (re-enqueue is a no-op)', async () => {
      const store = makeStore()
      const outbox = new TransactionOutbox(store)
      const first = await outbox.enqueue(entryInput())
      const second = await outbox.enqueue(entryInput({ xdr: 'DIFFERENT-but-same-hash' }))

      expect(second.createdAt).toBe(first.createdAt)
      expect(await outbox.list()).toHaveLength(1)
    })

    it('orders pending entries by sequence number ascending', async () => {
      const store = makeStore()
      const outbox = new TransactionOutbox(store)
      await outbox.enqueue(entryInput({ hash: 'b', sequence: '200' }))
      await outbox.enqueue(entryInput({ hash: 'a', sequence: '100' }))

      const pending = await outbox.pending()
      expect(pending.map(e => e.hash)).toEqual(['a', 'b'])
    })

    it('returns [] for a corrupt payload rather than throwing', async () => {
      const store = makeStore()
      store.setItem('invisible_wallet_outbox', '{not valid json')
      const outbox = new TransactionOutbox(store)
      expect(await outbox.list()).toEqual([])
    })
  })

  // ── replay: dedup / at-most-once ─────────────────────────────────────────────

  describe('replay()', () => {
    it('skips a transaction already on-chain without resubmitting (at-most-once)', async () => {
      const store = makeStore()
      const outbox = new TransactionOutbox(store)
      await outbox.enqueue(entryInput())

      const server = {
        getTransaction: jest.fn().mockResolvedValue(SUCCESS),
        sendTransaction: jest.fn(),
      } as any

      const result = await outbox.replay(server)

      expect(server.sendTransaction).not.toHaveBeenCalled()
      expect(result.skippedDuplicate).toHaveLength(1)
      expect(result.confirmed).toHaveLength(0)
      // Removed from the queue.
      expect(await outbox.pending()).toHaveLength(0)
    })

    it('submits a not-yet-seen transaction and confirms it', async () => {
      const store = makeStore()
      const outbox = new TransactionOutbox(store)
      await outbox.enqueue(entryInput())

      const server = {
        // 1st call (dedup check) → NOT_FOUND, 2nd call (waitFor) → SUCCESS
        getTransaction: jest.fn()
          .mockResolvedValueOnce(NOT_FOUND)
          .mockResolvedValueOnce(SUCCESS),
        sendTransaction: jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'hash-1' }),
      } as any

      const result = await outbox.replay(server)

      expect(server.sendTransaction).toHaveBeenCalledTimes(1)
      expect(result.confirmed).toHaveLength(1)
      expect(result.confirmed[0].hash).toBe('hash-1')
      expect(await outbox.pending()).toHaveLength(0)
    })

    it('drops a transaction the network reports as FAILED without resending', async () => {
      const store = makeStore()
      const outbox = new TransactionOutbox(store)
      await outbox.enqueue(entryInput())

      const server = {
        getTransaction: jest.fn().mockResolvedValue(FAILED),
        sendTransaction: jest.fn(),
      } as any

      const result = await outbox.replay(server)

      expect(server.sendTransaction).not.toHaveBeenCalled()
      expect(result.failed).toHaveLength(1)
      expect(await outbox.pending()).toHaveLength(0)
    })

    it('records a send ERROR as failed and removes it from the queue', async () => {
      const store = makeStore()
      const outbox = new TransactionOutbox(store)
      await outbox.enqueue(entryInput())

      const server = {
        getTransaction: jest.fn().mockResolvedValue(NOT_FOUND),
        sendTransaction: jest.fn().mockResolvedValue({
          status: 'ERROR',
          errorResult: { toXDR: () => 'base64error' },
        }),
      } as any

      const result = await outbox.replay(server)
      expect(result.failed).toHaveLength(1)
      expect(await outbox.pending()).toHaveLength(0)
    })
  })

  // ── offline → online transition ──────────────────────────────────────────────

  describe('offline → online transition', () => {
    it('keeps the entry queued while offline, then confirms it on reconnect', async () => {
      const store = makeStore()
      const outbox = new TransactionOutbox(store)
      await outbox.enqueue(entryInput())

      // OFFLINE: status lookup throws (no connectivity).
      const offlineServer = {
        getTransaction: jest.fn().mockRejectedValue(new Error('Network request failed')),
        sendTransaction: jest.fn(),
      } as any

      const offlineResult = await outbox.replay(offlineServer)
      expect(offlineServer.sendTransaction).not.toHaveBeenCalled()
      expect(offlineResult.stillPending).toHaveLength(1)
      // Survives — still queued for a later pass.
      expect(await outbox.pending()).toHaveLength(1)

      // ONLINE: now reachable; submit + confirm.
      const onlineServer = {
        getTransaction: jest.fn()
          .mockResolvedValueOnce(NOT_FOUND)
          .mockResolvedValueOnce(SUCCESS),
        sendTransaction: jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'hash-1' }),
      } as any

      const onlineResult = await outbox.replay(onlineServer)
      expect(onlineServer.sendTransaction).toHaveBeenCalledTimes(1)
      expect(onlineResult.confirmed).toHaveLength(1)
      expect(await outbox.pending()).toHaveLength(0)
    })

    it('increments the attempt counter when a send is left pending', async () => {
      const store = makeStore()
      const outbox = new TransactionOutbox(store)
      await outbox.enqueue(entryInput())

      const server = {
        getTransaction: jest.fn().mockResolvedValue(NOT_FOUND),
        sendTransaction: jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'hash-1' }),
      } as any

      // waitForConfirmation:false → leaves it pending after sending once.
      await outbox.replay(server, { waitForConfirmation: false })
      const pending: OutboxEntry[] = await outbox.pending()
      expect(pending).toHaveLength(1)
      expect(pending[0].attempts).toBe(1)
    })
  })
})
