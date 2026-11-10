/**
 * The gallery merge (`lib/nftGallery.ts`): an indexer failure must cost only
 * what the indexer alone knew, never the tokens the chain read can list.
 */

import { loadGallery } from '../nftGallery';
import type { NFTItem } from '../nfts';

jest.mock('../nfts', () => ({ fetchWalletNFTs: jest.fn() }));
jest.mock('../veilIansOwned', () => ({ fetchOwnedVeilIans: jest.fn() }));

const WALLET = 'CAWALLET000000000000000000000000000000000000000000000001';

function item(contractId: string, tokenId: string, name = `${contractId} ${tokenId}`): NFTItem {
  return {
    id: `${contractId}:${tokenId}`,
    contractId,
    tokenId,
    name,
    image: null,
    attributes: [],
    owner: WALLET,
    standard: 'CAP-46',
  };
}

const indexerDown = () => Promise.reject(new Error('Indexer returned HTTP 500'));

describe('loadGallery', () => {
  it('merges both sources and keeps the indexed copy of a token both report', async () => {
    const gallery = await loadGallery(WALLET, {
      fetchIndexed: async () => [item('CVEILIANS', '3', 'indexed'), item('COTHER', '1')],
      fetchOnChain: async () => [item('CVEILIANS', '3', 'chain'), item('CVEILIANS', '9')],
    });

    expect(gallery.indexerError).toBeNull();
    expect(gallery.items.map((i) => i.id)).toEqual(['CVEILIANS:3', 'COTHER:1', 'CVEILIANS:9']);
    expect(gallery.items[0].name).toBe('indexed');
  });

  it('shows what the chain lists when the indexer is down, and says the list may be short', async () => {
    // 2026-11-10: this case rendered a full-screen error instead.
    const gallery = await loadGallery(WALLET, {
      fetchIndexed: indexerDown,
      fetchOnChain: async () => [item('CVEILIANS', '9')],
    });

    expect(gallery.items.map((i) => i.id)).toEqual(['CVEILIANS:9']);
    expect(gallery.indexerError).toBe('Indexer returned HTTP 500');
  });

  it('still fails when the indexer is down and the chain lists nothing', async () => {
    // An empty gallery here would claim the wallet holds no NFTs, which nobody
    // established: only one collection was actually read.
    await expect(
      loadGallery(WALLET, { fetchIndexed: indexerDown, fetchOnChain: async () => [] }),
    ).rejects.toThrow('Indexer returned HTTP 500');
  });

  it('rethrows the indexer error itself, so its type survives', async () => {
    class Unconfigured extends Error {}
    const err = new Unconfigured('no indexer');

    await expect(
      loadGallery(WALLET, {
        fetchIndexed: () => Promise.reject(err),
        fetchOnChain: () => Promise.reject(new Error('rpc down')),
      }),
    ).rejects.toBe(err);
  });

  it('is unaffected by a failed chain read when the indexer answers', async () => {
    const gallery = await loadGallery(WALLET, {
      fetchIndexed: async () => [item('COTHER', '1')],
      fetchOnChain: () => Promise.reject(new Error('rpc down')),
    });

    expect(gallery).toEqual({ items: [item('COTHER', '1')], indexerError: null });
  });

  describe('with both of a user’s accounts', () => {
    const SPENDING = 'GASPENDING0000000000000000000000000000000000000000000001';

    it('asks the indexer about each account and the chain about both at once', async () => {
      const fetchIndexed = jest.fn(async (address: string) =>
        address === SPENDING ? [item('COTHER', '1')] : [],
      );
      const fetchOnChain = jest.fn(async () => [item('CVEILIANS', '9')]);

      const gallery = await loadGallery([WALLET, SPENDING], { fetchIndexed, fetchOnChain });

      expect(fetchIndexed.mock.calls.map(([a]) => a)).toEqual([WALLET, SPENDING]);
      expect(fetchOnChain).toHaveBeenCalledWith([WALLET, SPENDING]);
      expect(gallery.items.map((i) => i.id)).toEqual(['COTHER:1', 'CVEILIANS:9']);
      expect(gallery.indexerError).toBeNull();
    });

    it('keeps what one account’s lookup found when the other lookup fails', async () => {
      const gallery = await loadGallery([WALLET, SPENDING], {
        fetchIndexed: (address) =>
          address === WALLET ? Promise.resolve([item('COTHER', '1')]) : indexerDown(),
        fetchOnChain: async () => [],
      });

      expect(gallery.items.map((i) => i.id)).toEqual(['COTHER:1']);
      expect(gallery.indexerError).toBe('Indexer returned HTTP 500');
    });

    it('still fails when no lookup answered and the chain lists nothing', async () => {
      await expect(
        loadGallery([WALLET, SPENDING], { fetchIndexed: indexerDown, fetchOnChain: async () => [] }),
      ).rejects.toThrow('Indexer returned HTTP 500');
    });

    it('does not ask twice about the same account, or at all about a missing one', async () => {
      const fetchIndexed = jest.fn(async () => [] as NFTItem[]);

      await loadGallery([WALLET, '', WALLET], { fetchIndexed, fetchOnChain: async () => [] });

      expect(fetchIndexed).toHaveBeenCalledTimes(1);
    });
  });
});
