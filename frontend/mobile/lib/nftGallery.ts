/**
 * What the NFT gallery shows: the indexer's answer merged with the chain's.
 *
 * Two sources, deliberately. The indexer is the only thing that can enumerate
 * a collection nobody told us about. The chain is the authority on Veil's own
 * collection, whose address ships in the binary (`lib/veilIansOwned.ts`).
 *
 * They used to be joined with `Promise.all`, so the indexer failing took the
 * chain's answer down with it. On 2026-11-10 the indexer's database was
 * unreachable for hours and the whole screen was a red "Indexer returned HTTP
 * 500" card, over tokens the chain read would have listed without it. An
 * indexer failure now costs only what the indexer alone knew.
 */

import { errorMessage } from './errorMessage';
import { fetchWalletNFTs, type NFTItem } from './nfts';
import { fetchOwnedVeilIans } from './veilIansOwned';

export interface Gallery {
  items: NFTItem[];
  /**
   * Set when the indexer could not be asked and `items` is the chain's answer
   * alone. The list is then true but possibly incomplete, and the screen has
   * to say so: silence would read as "this is everything you hold".
   */
  indexerError: string | null;
}

export interface LoadGalleryDeps {
  fetchIndexed?: (address: string) => Promise<NFTItem[]>;
  fetchOnChain?: (address: string) => Promise<NFTItem[]>;
}

const keyOf = (item: NFTItem) => `${item.contractId}:${item.tokenId}`;

/**
 * Throws only when there is nothing truthful to show: the indexer failed and
 * the chain read found no tokens (or failed too). The indexer's own error is
 * rethrown unchanged, so `IndexerNotConfiguredError` still reaches the screen
 * as itself.
 */
export async function loadGallery(address: string, deps: LoadGalleryDeps = {}): Promise<Gallery> {
  const fetchIndexed = deps.fetchIndexed ?? ((a: string) => fetchWalletNFTs(a));
  const fetchOnChain = deps.fetchOnChain ?? fetchOwnedVeilIans;

  const [indexed, onChain] = await Promise.allSettled([fetchIndexed(address), fetchOnChain(address)]);
  const chainItems = onChain.status === 'fulfilled' ? onChain.value : [];

  if (indexed.status === 'rejected') {
    if (chainItems.length === 0) throw indexed.reason;
    return { items: chainItems, indexerError: errorMessage(indexed.reason) };
  }

  const seen = new Set(indexed.value.map(keyOf));
  return {
    items: [...indexed.value, ...chainItems.filter((item) => !seen.has(keyOf(item)))],
    indexerError: null,
  };
}
