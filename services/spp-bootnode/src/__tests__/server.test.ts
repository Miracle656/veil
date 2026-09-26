import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createServer } from '../server';
import { getIndexerStatus } from '../indexer';
import { queryEvents } from '../db';

vi.mock('../indexer', () => ({
  getIndexerStatus: vi.fn(),
}));

vi.mock('../db', () => ({
  queryEvents: vi.fn(),
}));

describe('Server', () => {
  let app: any;
  const mockDb = {} as any; // Mock DB object

  beforeEach(() => {
    vi.clearAllMocks();
    app = createServer(mockDb);
  });

  describe('GET /healthz', () => {
    it('returns 200 OK', async () => {
      const response = await request(app).get('/healthz');
      expect(response.status).toBe(200);
      expect(response.text).toBe('OK');
    });
  });

  describe('GET /status', () => {
    it('returns indexer status', async () => {
      const mockStatus = {
        state: 'running',
        pools: ['pool1'],
        lastLedger: 100,
        metrics: { totalEvents: 10, dbSizeBytes: 1024 },
      };
      vi.mocked(getIndexerStatus).mockReturnValue(mockStatus as any);

      const response = await request(app).get('/status');
      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockStatus);
    });
  });

  describe('GET /events', () => {
    it('returns 400 if pool is missing', async () => {
      const response = await request(app).get('/events');
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Required query param');
    });

    it('returns 400 if fromLedger is not a number', async () => {
      const response = await request(app).get('/events?pool=abc&fromLedger=xyz');
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('must be a positive integer');
    });

    it('returns 400 if limit is not a number', async () => {
      const response = await request(app).get('/events?pool=abc&fromLedger=10&limit=abc');
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('must be a positive integer');
    });

    it('calls queryEvents and returns rows', async () => {
      const mockRows = [{ ledger: 11, tx_hash: 'abc', pool: 'pool1' }];
      vi.mocked(queryEvents).mockReturnValue(mockRows as any);

      const response = await request(app).get('/events?pool=pool1&fromLedger=10&limit=50');
      
      expect(response.status).toBe(200);
      expect(response.body.events).toEqual(mockRows);
      expect(queryEvents).toHaveBeenCalledWith(mockDb, 'pool1', 10, 50);
    });
  });
});
