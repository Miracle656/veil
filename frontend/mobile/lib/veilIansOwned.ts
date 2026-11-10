/**
 * Which Veil-ians an address holds, read straight from the chain.
 *
 * The same reasoning as the web wallet's `lib/veilIansOwned.ts`. The gallery
 * otherwise needs Wraith to have indexed a transfer, which for this collection
 * means the mainnet indexer running, the contract in its watch list, and its
 * parser recognising a mint — a chain in which every link has broken, and each
 * break looked identical from the gallery: an empty shelf over a token the
 * chain had recorded.
 *
 * None of it is needed here. Twenty tokens at an address shipped in the binary,
 * `sold()` to say which exist, `owner_of` for the rest. Two RPC reads today,
 * twenty-one at worst.
 */

import { nativeToScVal } from '@stellar/stellar-sdk';

import { simulateRead } from './contractInvoke';
import type { NFTItem } from './nfts';
import {
  COLLECTION_SIZE,
  FIGURES,
  figureImageUrl,
  figureMetadataUrl,
  pad,
} from './veilIansFigures';
import { collectionContractId } from './veilIans';

/**
 * The Veil-ians this address owns, as gallery items.
 *
 * Empty when the collection is not on this network or nothing could be read:
 * the caller merges this with the indexer's answer, so a failure costs nothing
 * beyond what was already missing.
 */
export async function fetchOwnedVeilIans(address: string): Promise<NFTItem[]> {
  const contractId = collectionContractId();
  if (!contractId || !address) return [];

  // Only sold ids can have an owner; asking the rest is reads that can only
  // answer "nobody".
  const sold = await simulateRead(contractId, 'sold', []);
  if (!Array.isArray(sold) || sold.length === 0) return [];

  const ids = sold
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= COLLECTION_SIZE);

  const owners = await Promise.all(
    ids.map(async (id) => {
      const owner = await simulateRead(contractId, 'owner_of', [
        nativeToScVal(id, { type: 'u32' }),
      ]);
      return { id, owner: typeof owner === 'string' ? owner : null };
    }),
  );

  return owners
    .filter((o) => o.owner === address)
    .map(({ id }) => {
      const figure = FIGURES[id - 1];
      return {
        id: `${contractId}:${id}`,
        contractId,
        tokenId: String(id),
        name: `Veil-ian #${pad(id)}`,
        symbol: 'VEILIAN',
        description:
          'A veiled figure for Veil: a crowned mask over layered, patterned cloth falling to an uneven hem.',
        image: figureImageUrl(id),
        tokenUri: figureMetadataUrl(id),
        owner: address,
        standard: 'CAP-46' as const,
        attributes: [
          { trait_type: 'Crown', value: figure.crown },
          { trait_type: 'Aperture', value: figure.aperture },
          { trait_type: 'Ornament', value: figure.ornament },
          { trait_type: 'Palette', value: figure.palette },
          { trait_type: 'Hem', value: figure.hem },
        ],
      };
    });
}
