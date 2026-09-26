import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getIndexerStatus, startIndexer, stopIndexer } from '../indexer';

// Mock dependencies
vi.mock('../db', () => ({
  openDb: vi.fn(),
  getCheckpoint: vi.fn().mockReturnValue(0),
  setCheckpoint: vi.fn(),
  insertEvents: vi.fn(),
  countEvents: vi.fn().mockReturnValue(0),
  dbSizeBytes: vi.fn().mockReturnValue(0),
}));

const mockGetEvents = vi.fn();
vi.mock('@stellar/stellar-sdk', () => ({
  rpc: {
    Server: vi.fn().mockImplementation(() => ({
      getEvents: mockGetEvents,
    })),
  },
}));

describe('Indexer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes initial status correctly', () => {
    const status = getIndexerStatus();
    expect(status.state).toBe('stopped');
    expect(status.lastLedger).toBe(0);
    expect(status.pools).toEqual([]);
    expect(status.metrics.totalEvents).toBe(0);
    expect(status.metrics.dbSizeBytes).toBe(0);
  });

  it('can start and stop', async () => {
    startIndexer(':memory:', 'https://rpc.test', ['pool1']);
    
    let status = getIndexerStatus();
    expect(status.state).toBe('running');
    expect(status.pools).toContain('pool1');
    
    stopIndexer();
    
    // Wait for internal promises to settle if any (though in this case it just sets the flag)
    await new Promise(r => setTimeout(r, 10));
    
    status = getIndexerStatus();
    expect(status.state).toBe('stopped');
  });

  it('polls events correctly when running', async () => {
    // Return empty events to prevent infinite loops in the test
    mockGetEvents.mockResolvedValue({ events: [] });
    
    startIndexer(':memory:', 'https://rpc.test', ['pool1']);
    
    await new Promise(r => setTimeout(r, 100)); // allow polling to trigger
    
    expect(mockGetEvents).toHaveBeenCalled();
    
    stopIndexer();
  });
});
