import type { rpc } from '@stellar/stellar-sdk';

/**
 * The sequence number of the network's latest ledger.
 *
 * This exists because `server.getLatestLedger()` can throw on a perfectly
 * healthy network. From 15.1 the Stellar SDK also decodes the ledger header
 * that comes back with the answer, and a release older than the network's
 * protocol cannot read a header that uses something added since. On Protocol
 * 30 that is every header: 15.1.0 fails with
 * "XDR Read Error: unknown StellarValueType member for value 3", on mainnet
 * and on testnet. The sequence number it was asked for is right there in the
 * same reply, as plain JSON.
 *
 * So: ask the SDK first, and if it cannot decode the reply, ask the RPC
 * directly and read the one field that is needed. The header is never needed
 * here. If the direct call does not produce a usable number either, the
 * SDK's own error is the one thrown, since it is the one that says what went
 * wrong.
 */
export async function latestLedgerSequence(
    server: rpc.Server,
    fetchImpl: typeof fetch = globalThis.fetch,
): Promise<number> {
    try {
        return (await server.getLatestLedger()).sequence;
    } catch (sdkError) {
        const url = rpcUrlOf(server);
        if (!url || typeof fetchImpl !== 'function') throw sdkError;
        try {
            const res = await fetchImpl(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestLedger' }),
            });
            const body = (await res.json()) as { result?: { sequence?: unknown } };
            const sequence = Number(body?.result?.sequence);
            if (Number.isInteger(sequence) && sequence > 0) return sequence;
        } catch {
            /* fall through to the SDK's error */
        }
        throw sdkError;
    }
}

/** The URL an `rpc.Server` was made with, or null when it cannot be read. */
function rpcUrlOf(server: rpc.Server): string | null {
    const raw = (server as unknown as { serverURL?: { toString(): string } | string }).serverURL;
    if (!raw) return null;
    const url = typeof raw === 'string' ? raw : raw.toString();
    return /^https?:\/\//i.test(url) ? url : null;
}
