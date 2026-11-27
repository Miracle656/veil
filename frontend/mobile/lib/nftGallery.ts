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
 *
 * Both are asked about every address the user has, not only the smart wallet:
 * a figure bought on the web by a phone-made wallet is on the spending account
 * (`lib/ownAddresses.ts`), and a gallery that skipped it said "no NFTs" to
 * somebody who had bought one that afternoon.
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
  fetchOnChain?: (addresses: readonly string[]) => Promise<NFTItem[]>;
}

const keyOf = (item: NFTItem) => `${item.contractId}:${item.tokenId}`;

/**
 * Throws only when there is nothing truthful to show: the indexer answered for
 * none of the addresses and the chain read found no tokens (or failed too).
 * The indexer's own error is rethrown unchanged, so
 * `IndexerNotConfiguredError` still reaches the screen as itself.
 */
export async function loadGallery(
  addresses: string | readonly string[],
  deps: LoadGalleryDeps = {},
): Promise<Gallery> {
  const fetchIndexed = deps.fetchIndexed ?? ((a: string) => fetchWalletNFTs(a));
  const fetchOnChain = deps.fetchOnChain ?? fetchOwnedVeilIans;
  const own = [...new Set((typeof addresses === 'string' ? [addresses] : addresses).filter(Boolean))];

  const [indexed, chainItems] = await Promise.all([
    Promise.allSettled(own.map((address) => fetchIndexed(address))),
    Promise.resolve()
      .then(() => fetchOnChain(own))
      .catch((): NFTItem[] => []),
  ]);

  const failure = indexed.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  const answered = indexed.some((r) => r.status === 'fulfilled');
  if (failure && !answered && chainItems.length === 0) throw failure.reason;

  const indexedItems = indexed.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const seen = new Set(indexedItems.map(keyOf));
  return {
    items: [...indexedItems, ...chainItems.filter((item) => !seen.has(keyOf(item)))],
    indexerError: failure ? errorMessage(failure.reason) : null,
  };
}
