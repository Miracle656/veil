import type { rpc } from '@stellar/stellar-sdk';

import { latestLedgerSequence } from '../latestLedger';

const DECODE_ERROR = new TypeError('XDR Read Error: unknown StellarValueType member for value 3');

function server(over: { getLatestLedger: () => Promise<{ sequence: number }>; serverURL?: unknown }): rpc.Server {
    return over as unknown as rpc.Server;
}

const reply = (body: unknown) =>
    jest.fn(async () => ({ json: async () => body })) as unknown as typeof fetch;

describe('latestLedgerSequence', () => {
    it('uses the SDK answer when the SDK can read it, and makes no second request', async () => {
        const fetchImpl = reply({ result: { sequence: 999 } });
        const s = server({ getLatestLedger: async () => ({ sequence: 123 }), serverURL: 'https://rpc.invalid' });
        await expect(latestLedgerSequence(s, fetchImpl)).resolves.toBe(123);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('reads the sequence from the RPC directly when the SDK cannot decode the header', async () => {
        const fetchImpl = reply({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 30, sequence: 65716555, headerXdr: 'AAAA' } });
        const s = server({
            getLatestLedger: async () => { throw DECODE_ERROR; },
            serverURL: { toString: () => 'https://rpc.invalid/' },
        });
        await expect(latestLedgerSequence(s, fetchImpl)).resolves.toBe(65716555);
        const [url, init] = (fetchImpl as unknown as jest.Mock).mock.calls[0];
        expect(url).toBe('https://rpc.invalid/');
        expect(JSON.parse(init.body)).toEqual({ jsonrpc: '2.0', id: 1, method: 'getLatestLedger' });
    });

    it.each([
        ['no result', {}],
        ['a non-numeric sequence', { result: { sequence: 'soon' } }],
        ['zero', { result: { sequence: 0 } }],
        ['a fraction', { result: { sequence: 1.5 } }],
        ['an RPC error', { error: { code: -32601, message: 'method not found' } }],
    ])('throws the SDK error when the direct reply has %s', async (_label, body) => {
        const s = server({ getLatestLedger: async () => { throw DECODE_ERROR; }, serverURL: 'https://rpc.invalid' });
        await expect(latestLedgerSequence(s, reply(body))).rejects.toBe(DECODE_ERROR);
    });

    it('throws the SDK error when the direct request itself fails', async () => {
        const fetchImpl = jest.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
        const s = server({ getLatestLedger: async () => { throw DECODE_ERROR; }, serverURL: 'https://rpc.invalid' });
        await expect(latestLedgerSequence(s, fetchImpl)).rejects.toBe(DECODE_ERROR);
    });

    it('throws the SDK error when the server has no readable http URL', async () => {
        const fetchImpl = reply({ result: { sequence: 5 } });
        for (const serverURL of [undefined, '', 'ftp://rpc.invalid', { toString: () => 'javascript:alert(1)' }]) {
            const s = server({ getLatestLedger: async () => { throw DECODE_ERROR; }, serverURL });
            await expect(latestLedgerSequence(s, fetchImpl)).rejects.toBe(DECODE_ERROR);
        }
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
