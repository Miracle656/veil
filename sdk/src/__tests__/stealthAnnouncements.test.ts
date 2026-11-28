import { readStealthAnnouncements } from '../stealthAnnouncements';

const mockGetEvents = jest.fn();

jest.mock('@stellar/stellar-sdk', () => ({
  nativeToScVal: jest.fn((value: unknown, options: { type: string }) => ({
    toXDR: () => `${options.type}:${String(value)}`,
  })),
  scValToNative: jest.fn((value: { native: unknown }) => value.native),
  rpc: {
    Server: jest.fn().mockImplementation(() => ({ getEvents: mockGetEvents })),
  },
}));

function event(version = 1) {
  return {
    id: '0000000000000000001-0000000001',
    ledger: 42,
    txHash: 'transaction-hash',
    topic: [{ native: 'announce' }, { native: new Uint8Array([7]) }],
    value: { native: [version, new Uint8Array(32).fill(3), new Uint8Array([4, 5])] },
  };
}

const options = {
  rpcUrl: 'https://soroban-testnet.stellar.org',
  contractId: 'C'.padEnd(56, 'A'),
  startLedger: 1,
  viewTag: 7,
};

describe('readStealthAnnouncements', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('filters by contract and view tag and returns decoded announcements', async () => {
    mockGetEvents.mockResolvedValueOnce({ events: [event()], cursor: '' });

    await expect(readStealthAnnouncements(options)).resolves.toEqual([
      {
        id: '0000000000000000001-0000000001',
        ledger: 42,
        txHash: 'transaction-hash',
        version: 1,
        ephemeralPublicKey: new Uint8Array(32).fill(3),
        viewTag: 7,
        sealedNote: new Uint8Array([4, 5]),
      },
    ]);

    expect(mockGetEvents).toHaveBeenCalledWith({
      filters: [{
        type: 'contract',
        contractIds: [options.contractId],
        topics: [['symbol:announce', 'bytes:7']],
      }],
      startLedger: options.startLedger,
      limit: 100,
    });
  });

  it('checks the payload version and rejects unsupported announcements', async () => {
    mockGetEvents.mockResolvedValueOnce({ events: [event(2)], cursor: '' });

    await expect(readStealthAnnouncements(options)).rejects.toThrow(
      'Unsupported stealth announcement version: 2',
    );
  });

  it('follows RPC cursors to read subsequent pages', async () => {
    mockGetEvents
      .mockResolvedValueOnce({ events: [event()], cursor: 'next-page' })
      .mockResolvedValueOnce({ events: [], cursor: '' });

    await readStealthAnnouncements(options);

    expect(mockGetEvents).toHaveBeenNthCalledWith(2, {
      filters: [{
        type: 'contract',
        contractIds: [options.contractId],
        topics: [['symbol:announce', 'bytes:7']],
      }],
      cursor: 'next-page',
      limit: 100,
    });
  });

  it('rejects view tags outside the one-byte range before making an RPC request', async () => {
    await expect(readStealthAnnouncements({ ...options, viewTag: 256 })).rejects.toThrow(
      'viewTag must be an integer from 0 to 255',
    );
    expect(mockGetEvents).not.toHaveBeenCalled();
  });
});
