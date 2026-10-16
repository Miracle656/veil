import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  getIndexerStatus: vi.fn(),
  queryEvents: vi.fn(),
  countEvents: vi.fn(),
  dbSizeBytes: vi.fn(),
  indexedPools: vi.fn(),
}));

vi.mock('../indexer.js', () => ({ getIndexerStatus: mocks.getIndexerStatus }));
vi.mock('../db.js', () => ({
  queryEvents: mocks.queryEvents,
  countEvents: mocks.countEvents,
  dbSizeBytes: mocks.dbSizeBytes,
  indexedPools: mocks.indexedPools,
}));

import { createBootnodeServer } from '../server.js';

describe('SPP bootnode HTTP server', () => {
  let server: ReturnType<typeof createBootnodeServer>;
  const db = {} as never;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getIndexerStatus.mockReturnValue({
      running: true,
      lastIndexedLedger: 100,
      pools: ['pool1'],
      pollIntervalMs: 30_000,
      lastPollAt: null,
      lastError: null,
    });
    mocks.countEvents.mockReturnValue(10);
    mocks.dbSizeBytes.mockReturnValue(1024);
    mocks.indexedPools.mockReturnValue(['pool1']);
    mocks.queryEvents.mockReturnValue([]);
    server = createBootnodeServer({ db });
  });

  afterEach(async () => {
    await server.close();
  });

  it('serves a health check', async () => {
    const response = await request(server.httpServer).get('/healthz');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it('reports indexer and storage status', async () => {
    const response = await request(server.httpServer).get('/status');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      eventsCount: 10,
      lastIndexedLedger: 100,
      dbSizeBytes: 1024,
      pools: ['pool1'],
    });
  });

  it('requires a pool', async () => {
    const response = await request(server.httpServer).get('/events');
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('pool');
  });

  it('rejects invalid ledger and limit values', async () => {
    const invalidLedger = await request(server.httpServer)
      .get('/events?pool=pool1&fromLedger=nope');
    const invalidLimit = await request(server.httpServer)
      .get('/events?pool=pool1&fromLedger=10&limit=nope');

    expect(invalidLedger.status).toBe(400);
    expect(invalidLimit.status).toBe(400);
  });

  it('queries the selected pool and returns its indexed events', async () => {
    const rows = [{ ledger: 11, tx_hash: 'abc', pool: 'pool1' }];
    mocks.queryEvents.mockReturnValue(rows);

    const response = await request(server.httpServer)
      .get('/events?pool=pool1&fromLedger=10&limit=50');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ events: rows, count: 1 });
    expect(mocks.queryEvents).toHaveBeenCalledWith(db, { pool: 'pool1', fromLedger: 10, limit: 50 });
  });
});
