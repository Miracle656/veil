/**
 * CAP-46 NFT holdings, read from the Wraith indexer.
 *
 * Wraith indexes NFT transfers separately from fungible ones (`NftTransfer`,
 * keyed by contract + token id) and exposes them at `/nfts/transfers` and
 * `/nfts/owners/:contract/:token_id`. This module reads those, not the general
 * `/transfers` feed — a token id has no meaning there.
 *
 * The distinction that matters: a transfer feed says what *moved*, not what is
 * *held*. Ownership is the destination of a token's most recent transfer, which
 * is how Wraith answers `/nfts/owners` too. A token sent away has a later
 * transfer whose `toAddress` is someone else, so it drops out.
 */

export interface NFTAttribute {
  trait_type: string
  value: string | number
}

export interface NFTItem {
  id: string
  contractId: string
  tokenId: string
  name: string
  symbol?: string
  description?: string
  /** Resolved image URL, or null when the token exposes none. Never a stand-in. */
  image: string | null
  /** The raw `tokenUri` off-chain pointer, for linking out. */
  tokenUri?: string | null
  attributes: NFTAttribute[]
  owner: string
  standard: 'CAP-46'
  isFixture?: boolean
  collectionName?: string
  /** Ledger close time of the transfer that put this token in the wallet. */
  acquiredAt?: string
  txHash?: string
}

/** Raw row as Wraith returns it from `/nfts/transfers`. */
interface WraithNftTransfer {
  id: number
  contractId: string
  tokenId: string
  fromAddress: string | null
  toAddress: string | null
  ledger: number
  ledgerClosedAt: string
  txHash: string
}

/**
 * Thrown when `NEXT_PUBLIC_WRAITH_URL` is unset. Distinct from a network
 * failure: nothing is wrong, the app simply has nowhere to ask, and the UI
 * should say that rather than render an empty gallery that implies the wallet
 * holds nothing.
 */
export class IndexerNotConfiguredError extends Error {
  constructor() {
    super('No NFT indexer configured. Set NEXT_PUBLIC_WRAITH_URL to a Wraith deployment.')
    this.name = 'IndexerNotConfiguredError'
  }
}

/**
 * Demonstration NFTs, rendered only behind an explicit opt-in
 * (`NEXT_PUBLIC_NFT_FIXTURES=1`, or `includeFixtures: true`).
 *
 * Never a fallback for an empty result or a failed fetch. A gallery that fills
 * itself with invented items when the indexer is down is worse than an error:
 * it tells the user something false about their own wallet, and it looks
 * exactly like success.
 */
export const FIXTURE_NFTS: NFTItem[] = [
  {
    id: 'fixture-genesis-1',
    contractId: 'CFIXTURE000000000000000000000000000000000000000000001',
    tokenId: '1',
    name: 'Soroban Genesis Pass #001',
    symbol: 'GENESIS',
    collectionName: 'Fixture Collection (not a real token)',
    description: 'Demonstration item. Present only because NEXT_PUBLIC_NFT_FIXTURES is set.',
    image: null,
    attributes: [
      { trait_type: 'Tier', value: 'Founder' },
      { trait_type: 'Standard', value: 'CAP-46' },
    ],
    owner: 'GFIXTURE000000000000000000000000000000000000000000001',
    standard: 'CAP-46',
    isFixture: true,
  },
  {
    id: 'fixture-cyber-42',
    contractId: 'CFIXTURE000000000000000000000000000000000000000000002',
    tokenId: '42',
    name: 'Veil Cyber Pass #042',
    symbol: 'CYBER',
    collectionName: 'Fixture Collection (not a real token)',
    description: 'Demonstration item. Present only because NEXT_PUBLIC_NFT_FIXTURES is set.',
    image: null,
    attributes: [
      { trait_type: 'Edition', value: '42 of 500' },
      { trait_type: 'Standard', value: 'CAP-46' },
    ],
    owner: 'GFIXTURE000000000000000000000000000000000000000000001',
    standard: 'CAP-46',
    isFixture: true,
  },
]

export interface FetchNFTsOptions {
  includeFixtures?: boolean
  wraithUrl?: string
  /** Which chain to read. Defaults to whatever the wallet is pointed at. */
  network?: string
  /** Injectable for tests. */
  fetchImpl?: typeof fetch
}

/** Shortens a Stellar/Soroban address for display. */
export function truncateAddress(address: string, start = 6, end = 6): string {
  if (!address || address.length <= start + end) return address || ''
  return `${address.slice(0, start)}…${address.slice(-end)}`
}

/** Renders a token id as `#42`, without doubling an existing `#`. */
export function formatTokenId(id: string | number): string {
  const s = String(id)
  return s.startsWith('#') ? s : `#${s}`
}

/** IPFS pointers need a gateway before a browser can render them. */
function resolveUri(uri: string | null | undefined): string | null {
  if (!uri) return null
  if (uri.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${uri.slice('ipfs://'.length)}`
  if (uri.startsWith('http://') || uri.startsWith('https://') || uri.startsWith('data:')) return uri
  return null
}

/**
 * Reduce a transfer feed to the tokens `walletAddress` currently holds.
 *
 * Exported for tests: this is the part with the actual reasoning in it, and it
 * is worth being able to check without a network.
 */
export function currentHoldings(
  transfers: WraithNftTransfer[],
  walletAddress: string,
): WraithNftTransfer[] {
  const latest = new Map<string, WraithNftTransfer>()

  for (const t of transfers) {
    const key = `${t.contractId}:${t.tokenId}`
    const seen = latest.get(key)
    // Ledger first, then row id — two transfers of one token can share a
    // ledger, and insertion order is not guaranteed to be chronological.
    if (!seen || t.ledger > seen.ledger || (t.ledger === seen.ledger && t.id > seen.id)) {
      latest.set(key, t)
    }
  }

  return [...latest.values()].filter((t) => t.toAddress === walletAddress)
}

/** One page of `/nfts/transfers`, following `total` until the feed is exhausted. */
async function fetchAllTransfers(
  base: string,
  walletAddress: string,
  network: string,
  doFetch: typeof fetch,
): Promise<WraithNftTransfer[]> {
  const PAGE = 200
  const MAX_PAGES = 10 // 2,000 transfers; past that the gallery is not the right tool
  const all: WraithNftTransfer[] = []

  for (let page = 0; page < MAX_PAGES; page++) {
    const url =
      `${base.replace(/\/$/, '')}/nfts/transfers` +
      `?address=${encodeURIComponent(walletAddress)}` +
      `&network=${encodeURIComponent(network)}` +
      `&limit=${PAGE}&offset=${page * PAGE}`

    const res = await doFetch(url)
    if (!res.ok) {
      throw new Error(`Indexer returned HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`)
    }

    const body = await res.json()
    const rows: WraithNftTransfer[] = Array.isArray(body?.transfers) ? body.transfers : []
    all.push(...rows)

    if (rows.length < PAGE) break
  }

  return all
}

/**
 * Ask the indexer for a token's owner and cached metadata.
 *
 * Also serves as a confirmation: `currentHoldings` derives ownership from the
 * transfer feed, and this is Wraith's own answer to the same question. A
 * mismatch means the wallet no longer holds the token, so it is dropped.
 */
async function fetchTokenDetail(
  base: string,
  contractId: string,
  tokenId: string,
  network: string,
  doFetch: typeof fetch,
): Promise<{ owner: string; name: string | null; tokenUri: string | null } | null> {
  const url =
    `${base.replace(/\/$/, '')}/nfts/owners/${encodeURIComponent(contractId)}/${encodeURIComponent(tokenId)}` +
    `?network=${encodeURIComponent(network)}`

  const res = await doFetch(url).catch(() => null)
  if (!res || !res.ok) return null

  const body = await res.json().catch(() => null)
  if (!body?.owner) return null

  return {
    owner: body.owner,
    name: body.metadata?.name ?? null,
    tokenUri: body.metadata?.tokenUri ?? null,
  }
}

/**
 * Best-effort read of an off-chain metadata document.
 *
 * `tokenUri` conventionally points at JSON with `name` / `image` /
 * `attributes`, but it is a URL someone else controls: it can be missing,
 * slow, or not JSON at all. Every failure here degrades to "no metadata"
 * rather than failing the gallery.
 */
async function fetchTokenMetadata(
  tokenUri: string,
  doFetch: typeof fetch,
): Promise<{ name?: string; description?: string; image?: string; attributes?: NFTAttribute[] } | null> {
  const url = resolveUri(tokenUri)
  if (!url) return null

  const res = await doFetch(url).catch(() => null)
  if (!res || !res.ok) return null

  const body = await res.json().catch(() => null)
  if (!body || typeof body !== 'object') return null

  return {
    name:        typeof body.name === 'string' ? body.name : undefined,
    description: typeof body.description === 'string' ? body.description : undefined,
    image:       typeof body.image === 'string' ? body.image : undefined,
    attributes:  Array.isArray(body.attributes) ? body.attributes : undefined,
  }
}

/**
 * The CAP-46 NFTs `walletAddress` currently holds.
 *
 * Throws {@link IndexerNotConfiguredError} when no indexer is configured, and a
 * plain `Error` when one is configured but unreachable. Both are distinct from
 * an empty array, which means the indexer answered and the wallet holds nothing
 * — the gallery renders a different thing for each.
 */
export async function fetchWalletNFTs(
  walletAddress: string,
  options: FetchNFTsOptions = {},
): Promise<NFTItem[]> {
  const envFixtures =
    process.env.NEXT_PUBLIC_NFT_FIXTURES === '1' ||
    process.env.NEXT_PUBLIC_NFT_FIXTURES === 'true'

  const includeFixtures = options.includeFixtures ?? envFixtures
  const doFetch = options.fetchImpl ?? fetch
  const base = options.wraithUrl ?? process.env.NEXT_PUBLIC_WRAITH_URL

  const items: NFTItem[] = []

  if (walletAddress) {
    if (!base) throw new IndexerNotConfiguredError()

    // Imported lazily: `./network` pulls in the whole Stellar SDK, and the
    // caller usually knows the network already. `getNetworkName()` is still the
    // right default — it honours the runtime network switch, which the
    // build-time NEXT_PUBLIC_NETWORK does not.
    const network = options.network ?? (await import('./network')).getNetworkName()

    const held = currentHoldings(
      await fetchAllTransfers(base, walletAddress, network, doFetch),
      walletAddress,
    )

    const enriched: (NFTItem | null)[] = await Promise.all(
      held.map(async (t): Promise<NFTItem | null> => {
        const detail = await fetchTokenDetail(base, t.contractId, t.tokenId, network, doFetch)

        // The indexer disagrees that this wallet holds the token — trust the
        // indexer's own answer over our reduction of its feed.
        if (detail && detail.owner !== walletAddress) return null

        const meta = detail?.tokenUri ? await fetchTokenMetadata(detail.tokenUri, doFetch) : null

        return {
          id: `${t.contractId}:${t.tokenId}`,
          contractId: t.contractId,
          tokenId: t.tokenId,
          name: meta?.name ?? detail?.name ?? `${truncateAddress(t.contractId)} ${formatTokenId(t.tokenId)}`,
          description: meta?.description,
          image: resolveUri(meta?.image),
          tokenUri: detail?.tokenUri ?? null,
          attributes: meta?.attributes ?? [],
          owner: detail?.owner ?? walletAddress,
          standard: 'CAP-46' as const,
          isFixture: false,
          acquiredAt: t.ledgerClosedAt,
          txHash: t.txHash,
        }
      }),
    )

    items.push(...enriched.filter((n): n is NFTItem => n !== null))
  }

  if (includeFixtures) {
    const seen = new Set(items.map((n) => n.id))
    items.push(...FIXTURE_NFTS.filter((f) => !seen.has(f.id)))
  }

  return items
}
