import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getEvents: vi.fn() }));

vi.mock('../db.js', () => ({
  getCheckpoint: vi.fn().mockReturnValue(0),
  setCheckpoint: vi.fn(),
  insertEvents: vi.fn(),
  countEvents: vi.fn().mockReturnValue(0),
  dbSizeBytes: vi.fn().mockReturnValue(0),
}));

vi.mock('@stellar/stellar-sdk', () => ({
  rpc: {
    Server: vi.fn().mockImplementation(() => ({ getEvents: mocks.getEvents })),
  },
}));

import { getIndexerStatus, startIndexer } from '../indexer.js';

describe('SPP event indexer', () => {
  let stop: (() => Promise<void>) | undefined;
  const db = {} as never;
  const config = {
    rpcUrl: 'https://rpc.test',
    networkPassphrase: 'Test SDF Network ; September 2015',
    poolAddresses: ['pool1'],
    pollIntervalMs: 60_000,
    pageSize: 200,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEvents.mockResolvedValue({ events: [], cursor: '' });
  });

  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  it('exposes the initial stopped state', () => {
    const status = getIndexerStatus();
    expect(status.running).toBe(false);
    expect(status.lastIndexedLedger).toBe(0);
    expect(status.pools).toEqual([]);
  });

  it('starts and stops cleanly', async () => {
    stop = startIndexer(db, config).stop;
    expect(getIndexerStatus()).toMatchObject({ running: true, pools: ['pool1'] });

    await stop();
    stop = undefined;
    expect(getIndexerStatus().running).toBe(false);
  });

  it('polls the configured pool from the checkpoint', async () => {
    stop = startIndexer(db, config).stop;

    await vi.waitFor(() => expect(mocks.getEvents).toHaveBeenCalledWith({
      startLedger: 1,
      filters: [{ type: 'contract', contractIds: ['pool1'] }],
      limit: 200,
    }));
  });
});
