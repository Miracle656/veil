/**
 * Which Veil-ians an address holds, read straight from the chain.
 *
 * The gallery otherwise depends on Wraith having indexed a transfer, and for
 * this collection that is a long chain of things that must all be true: the
 * mainnet indexer running, the contract in its watch list, and its parser
 * recognising a mint — which for a long time it did not, because a mint is
 * two topics where a transfer is four. Every link in that chain has broken at
 * least once, and each time the failure looked identical from the gallery: an
 * empty shelf over a token the chain had recorded.
 *
 * None of it is necessary here. The collection is twenty tokens with a known
 * contract, `sold()` says which exist in one call, and `owner_of` is the
 * contract's own answer to the only question being asked. That is at most
 * twenty-one reads and usually two, against an indexer that may be minutes
 * behind or years from having been deployed.
 *
 * This does not replace the indexer, which is the only thing that can enumerate
 * an arbitrary collection. It replaces it for the one collection we ship.
 */

import { nativeToScVal, rpc as SorobanRpc } from '@stellar/stellar-sdk'

import { FIGURES, figureImageUrl, figureMetadataUrl, pad } from './masqueradeFigures'
import { masqueradeContractIdFor } from './masqueradeContractId'
import { getNetwork } from './network'
import { simulateRead } from './sorobanRead'
import type { NFTItem } from './nfts'

/**
 * The Veil-ians this address owns, as gallery items.
 *
 * Returns an empty array when the collection is not deployed on this network
 * or nothing could be read — the caller merges this with the indexer's answer,
 * so a failure here costs nothing beyond what was already there.
 */
export async function fetchOwnedVeilIans(address: string): Promise<NFTItem[]> {
  const contractId = masqueradeContractIdFor(getNetwork().name)
  if (!contractId || !address) return []

  const net = getNetwork()
  const rpc = new SorobanRpc.Server(net.rpcUrl)

  // Only sold ids can have an owner, and asking the other nineteen would be
  // nineteen reads that can only answer "nobody".
  const sold = await simulateRead(rpc, contractId, 'sold', [], net.networkPassphrase)
  if (!Array.isArray(sold) || sold.length === 0) return []

  const ids = sold
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= FIGURES.length)

  const owners = await Promise.all(
    ids.map(async (id) => {
      const owner = await simulateRead(
        rpc,
        contractId,
        'owner_of',
        [nativeToScVal(id, { type: 'u32' })],
        net.networkPassphrase,
      )
      return { id, owner: typeof owner === 'string' ? owner : null }
    }),
  )

  return owners
    .filter((o) => o.owner === address)
    .map(({ id }) => {
      const figure = FIGURES[id - 1]
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
      }
    })
}
