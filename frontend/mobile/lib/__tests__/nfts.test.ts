/**
 * Tests for the mobile NFT gallery data layer (`lib/nfts.ts`).
 *
 * The gallery must distinguish three outcomes: the wallet holds items, it
 * holds nothing, and the metadata behind an item failed. Only the first two
 * touch the indexer; the third is the degradation path — a token whose
 * off-chain document is missing or malformed still appears, with no image and
 * no attributes, rather than dropping out or failing the fetch.
 */

import {
  currentHoldings,
  fetchWalletNFTs,
  IndexerNotConfiguredError,
  type WraithNftTransfer,
} from '../nfts';

const WALLET = 'CAWALLET000000000000000000000000000000000000000000000001';
const OTHER = 'CAOTHER000000000000000000000000000000000000000000000002';
const CONTRACT = 'CCONTRACT000000000000000000000000000000000000000000001';

function transfer(over: Partial<WraithNftTransfer>): WraithNftTransfer {
  return {
    id: 1,
    contractId: CONTRACT,
    tokenId: '7',
    fromAddress: null,
    toAddress: WALLET,
    ledger: 100,
    ledgerClosedAt: '2026-01-01T00:00:00Z',
    txHash: 'txhash1',
    ...over,
  };
}

/** Minimal fetch stub keyed on URL substring. */
function stubFetch(
  handlers: Array<{ match: string; response: { ok: boolean; status?: number; json: unknown } | null }>,
): typeof fetch {
  return (async (url: unknown) => {
    const u = String(url);
    for (const h of handlers) {
      if (u.includes(h.match)) {
        if (h.response === null) throw new Error('network down');
        const { ok, status = 200, json } = h.response;
        return { ok, status, json: async () => json } as unknown as Response;
      }
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
}

describe('currentHoldings', () => {
  it('keeps a token whose latest transfer arrives at the wallet', () => {
    const held = currentHoldings([transfer({})], WALLET);
    expect(held).toHaveLength(1);
  });

  it('drops a token the wallet sent away', () => {
    const held = currentHoldings(
      [transfer({ id: 1, ledger: 100, toAddress: WALLET }), transfer({ id: 2, ledger: 101, fromAddress: WALLET, toAddress: OTHER })],
      WALLET,
    );
    expect(held).toHaveLength(0);
  });
});

describe('fetchWalletNFTs', () => {
  it('returns [] when the indexer answers and the wallet holds nothing', async () => {
    const doFetch = stubFetch([{ match: '/nfts/transfers', response: { ok: true, json: { transfers: [] } } }]);
    const items = await fetchWalletNFTs(WALLET, {
      wraithUrl: 'https://wraith.example',
      network: 'testnet',
      fetchImpl: doFetch,
    });
    expect(items).toEqual([]);
  });

  it('returns a populated item with resolved metadata', async () => {
    const doFetch = stubFetch([
      { match: '/nfts/transfers', response: { ok: true, json: { transfers: [transfer({})] } } },
      {
        match: '/nfts/owners/',
        response: { ok: true, json: { owner: WALLET, metadata: { name: 'On-Chain Name', tokenUri: 'https://meta.example/7.json' } } },
      },
      {
        match: 'meta.example',
        response: {
          ok: true,
          json: { name: 'Cool NFT #7', description: 'A test token', image: 'ipfs://bafyimage', attributes: [{ trait_type: 'Tier', value: 'Gold' }] },
        },
      },
    ]);
    const [item] = await fetchWalletNFTs(WALLET, {
      wraithUrl: 'https://wraith.example',
      network: 'testnet',
      fetchImpl: doFetch,
    });
    expect(item).toMatchObject({
      id: `${CONTRACT}:7`,
      name: 'Cool NFT #7',
      owner: WALLET,
      standard: 'CAP-46',
    });
    expect(item.image).toBe('https://ipfs.io/ipfs/bafyimage');
    expect(item.attributes).toEqual([{ trait_type: 'Tier', value: 'Gold' }]);
  });

  it('degrades failed metadata to a placeholder item, never a crash', async () => {
    const doFetch = stubFetch([
      { match: '/nfts/transfers', response: { ok: true, json: { transfers: [transfer({})] } } },
      {
        match: '/nfts/owners/',
        response: { ok: true, json: { owner: WALLET, metadata: { name: null, tokenUri: 'https://meta.example/7.json' } } },
      },
      // Metadata endpoint unreachable: fetch rejects.
      { match: 'meta.example', response: null },
    ]);
    const [item] = await fetchWalletNFTs(WALLET, {
      wraithUrl: 'https://wraith.example',
      network: 'testnet',
      fetchImpl: doFetch,
    });
    expect(item).toBeDefined();
    expect(item.image).toBeNull();
    expect(item.attributes).toEqual([]);
    // Falls back to a derived name, never an empty string.
    expect(item.name).toContain('#7');
  });

  it('throws IndexerNotConfiguredError when no indexer URL is set', async () => {
    await expect(
      fetchWalletNFTs(WALLET, { wraithUrl: '', network: 'testnet', fetchImpl: stubFetch([]) }),
    ).rejects.toBeInstanceOf(IndexerNotConfiguredError);
  });
});
