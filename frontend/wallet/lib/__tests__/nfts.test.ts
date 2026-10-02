/// <reference types="jest" />

import {
  FIXTURE_NFTS,
  IndexerNotConfiguredError,
  currentHoldings,
  fetchWalletNFTs,
  formatTokenId,
  truncateAddress,
  type NFTItem,
} from '../nfts'

const WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWLT'
const OTHER  = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBOTHR'
const NFT_C  = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANFT'

function transfer(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    contractId: NFT_C,
    tokenId: '1',
    fromAddress: null,
    toAddress: WALLET,
    ledger: 100,
    ledgerClosedAt: '2026-01-01T00:00:00Z',
    txHash: 'abc123',
    ...over,
  } as never
}

/** Routes a mocked fetch by URL path, so one test can serve both endpoints. */
function mockIndexer(routes: Record<string, unknown>, opts: { fail?: number } = {}) {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (opts.fail) {
      return { ok: false, status: opts.fail, statusText: 'Server Error' } as Response
    }
    const key = Object.keys(routes).find((k) => url.includes(k))
    if (!key) return { ok: false, status: 404, statusText: 'Not Found' } as Response
    return { ok: true, json: async () => routes[key] } as Response
  }) as unknown as typeof fetch
}

const BASE = { wraithUrl: 'https://indexer.test', network: 'testnet' as const }

describe('nfts', () => {
  describe('truncateAddress', () => {
    it('elides the middle of a contract address', () => {
      expect(truncateAddress(NFT_C, 6, 6)).toBe('CAAAAA…AAANFT')
    })

    it('leaves an address shorter than the elision alone', () => {
      expect(truncateAddress('C123')).toBe('C123')
      expect(truncateAddress('')).toBe('')
    })
  })

  describe('formatTokenId', () => {
    it('prefixes a bare id', () => {
      expect(formatTokenId(42)).toBe('#42')
      expect(formatTokenId('777')).toBe('#777')
    })

    it('does not double an existing prefix', () => {
      expect(formatTokenId('#100')).toBe('#100')
    })
  })

  describe('currentHoldings', () => {
    it('keeps a token whose latest transfer landed in the wallet', () => {
      const held = currentHoldings([transfer()], WALLET)
      expect(held).toHaveLength(1)
      expect(held[0].tokenId).toBe('1')
    })

    it('drops a token that was later sent away', () => {
      // Received at ledger 100, sent on at ledger 200. The wallet appears in
      // both rows, which is exactly why a raw transfer feed cannot be read as
      // a holdings list.
      const held = currentHoldings(
        [
          transfer({ id: 1, ledger: 100, toAddress: WALLET }),
          transfer({ id: 2, ledger: 200, fromAddress: WALLET, toAddress: OTHER }),
        ],
        WALLET,
      )
      expect(held).toEqual([])
    })

    it('keeps a token that came back', () => {
      const held = currentHoldings(
        [
          transfer({ id: 1, ledger: 100, toAddress: WALLET }),
          transfer({ id: 2, ledger: 200, fromAddress: WALLET, toAddress: OTHER }),
          transfer({ id: 3, ledger: 300, fromAddress: OTHER, toAddress: WALLET }),
        ],
        WALLET,
      )
      expect(held).toHaveLength(1)
    })

    it('breaks a same-ledger tie by row id', () => {
      const held = currentHoldings(
        [
          transfer({ id: 9, ledger: 100, fromAddress: WALLET, toAddress: OTHER }),
          transfer({ id: 4, ledger: 100, toAddress: WALLET }),
        ],
        WALLET,
      )
      expect(held).toEqual([])
    })

    it('tracks tokens from one contract independently', () => {
      const held = currentHoldings(
        [
          transfer({ id: 1, tokenId: '1', toAddress: WALLET }),
          transfer({ id: 2, tokenId: '2', ledger: 200, fromAddress: WALLET, toAddress: OTHER }),
          transfer({ id: 3, tokenId: '2', ledger: 100, toAddress: WALLET }),
        ],
        WALLET,
      )
      expect(held.map((t) => t.tokenId)).toEqual(['1'])
    })

    it('returns nothing for a wallet that appears only as a sender', () => {
      expect(currentHoldings([transfer({ fromAddress: WALLET, toAddress: OTHER })], WALLET)).toEqual([])
    })
  })

  describe('fetchWalletNFTs', () => {
    it('reports a missing indexer distinctly from an empty wallet', async () => {
      await expect(
        fetchWalletNFTs(WALLET, { wraithUrl: undefined, network: 'testnet', fetchImpl: mockIndexer({}) }),
      ).rejects.toBeInstanceOf(IndexerNotConfiguredError)
    })

    it('propagates an indexer failure rather than returning empty', async () => {
      await expect(
        fetchWalletNFTs(WALLET, { ...BASE, fetchImpl: mockIndexer({}, { fail: 500 }) }),
      ).rejects.toThrow('Indexer returned HTTP 500')
    })

    it('returns an empty list when the wallet holds nothing', async () => {
      const nfts = await fetchWalletNFTs(WALLET, {
        ...BASE,
        includeFixtures: false,
        fetchImpl: mockIndexer({ '/nfts/transfers': { transfers: [] } }),
      })
      expect(nfts).toEqual([])
    })

    it('builds an item from a held token and its metadata', async () => {
      const nfts = await fetchWalletNFTs(WALLET, {
        ...BASE,
        includeFixtures: false,
        fetchImpl: mockIndexer({
          '/nfts/transfers': { transfers: [transfer({ tokenId: '888' })] },
          '/nfts/owners':    { owner: WALLET, metadata: { name: 'Indexed Name', tokenUri: 'https://meta.test/888' } },
          'meta.test':       { name: 'Metadata Name', image: 'https://img.test/888.png', attributes: [{ trait_type: 'Rarity', value: 'Epic' }] },
        }),
      })

      expect(nfts).toHaveLength(1)
      expect(nfts[0]).toMatchObject({
        id: `${NFT_C}:888`,
        tokenId: '888',
        name: 'Metadata Name',
        image: 'https://img.test/888.png',
        owner: WALLET,
        standard: 'CAP-46',
        isFixture: false,
        txHash: 'abc123',
      })
      expect(nfts[0].attributes).toEqual([{ trait_type: 'Rarity', value: 'Epic' }])
    })

    it('drops a token the indexer says belongs to someone else', async () => {
      // The transfer feed can lag the owner index; the owner index wins.
      const nfts = await fetchWalletNFTs(WALLET, {
        ...BASE,
        includeFixtures: false,
        fetchImpl: mockIndexer({
          '/nfts/transfers': { transfers: [transfer()] },
          '/nfts/owners':    { owner: OTHER, metadata: null },
        }),
      })
      expect(nfts).toEqual([])
    })

    it('renders a token whose metadata is unreachable, without inventing any', async () => {
      const nfts = await fetchWalletNFTs(WALLET, {
        ...BASE,
        includeFixtures: false,
        fetchImpl: mockIndexer({
          '/nfts/transfers': { transfers: [transfer({ tokenId: '5' })] },
          '/nfts/owners':    { owner: WALLET, metadata: { name: null, tokenUri: 'https://dead.example/5' } },
        }),
      })

      expect(nfts).toHaveLength(1)
      expect(nfts[0].image).toBeNull()
      expect(nfts[0].description).toBeUndefined()
      expect(nfts[0].attributes).toEqual([])
      // Falls back to an identifier that is true, rather than a placeholder title.
      expect(nfts[0].name).toBe('CAAAAA…AAANFT #5')
    })

    it('resolves an ipfs:// image through a gateway', async () => {
      const nfts = await fetchWalletNFTs(WALLET, {
        ...BASE,
        includeFixtures: false,
        fetchImpl: mockIndexer({
          '/nfts/transfers': { transfers: [transfer()] },
          '/nfts/owners':    { owner: WALLET, metadata: { name: 'X', tokenUri: 'ipfs://QmMeta' } },
          'ipfs.io':         { name: 'X', image: 'ipfs://QmImage' },
        }),
      })
      expect(nfts[0].image).toBe('https://ipfs.io/ipfs/QmImage')
    })

    it('paginates until the feed is exhausted', async () => {
      const page1 = Array.from({ length: 200 }, (_, i) => transfer({ id: i + 1, tokenId: String(i + 1) }))
      const page2 = [transfer({ id: 201, tokenId: '201' })]
      let call = 0

      const fetchImpl = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/nfts/transfers')) {
          return { ok: true, json: async () => ({ transfers: call++ === 0 ? page1 : page2 }) } as Response
        }
        return { ok: true, json: async () => ({ owner: WALLET, metadata: null }) } as Response
      }) as unknown as typeof fetch

      const nfts = await fetchWalletNFTs(WALLET, { ...BASE, includeFixtures: false, fetchImpl })
      expect(nfts).toHaveLength(201)
    })

    it('omits fixtures unless asked', async () => {
      const nfts = await fetchWalletNFTs(WALLET, {
        ...BASE,
        includeFixtures: false,
        fetchImpl: mockIndexer({ '/nfts/transfers': { transfers: [] } }),
      })
      expect(nfts.some((n: NFTItem) => n.isFixture)).toBe(false)
    })

    it('includes fixtures when explicitly opted in', async () => {
      const nfts = await fetchWalletNFTs(WALLET, {
        ...BASE,
        includeFixtures: true,
        fetchImpl: mockIndexer({ '/nfts/transfers': { transfers: [] } }),
      })
      expect(nfts).toHaveLength(FIXTURE_NFTS.length)
      expect(nfts.every((n) => n.isFixture)).toBe(true)
    })

    it('never presents fixtures as belonging to the connected wallet', async () => {
      const nfts = await fetchWalletNFTs(WALLET, {
        ...BASE,
        includeFixtures: true,
        fetchImpl: mockIndexer({ '/nfts/transfers': { transfers: [] } }),
      })
      for (const fixture of nfts) expect(fixture.owner).not.toBe(WALLET)
    })

    it('does not fall back to fixtures when the indexer fails', async () => {
      // The failure mode that matters: a gallery that invents holdings when the
      // network is down tells the user something false about their own wallet.
      await expect(
        fetchWalletNFTs(WALLET, { ...BASE, includeFixtures: true, fetchImpl: mockIndexer({}, { fail: 503 }) }),
      ).rejects.toThrow('Indexer returned HTTP 503')
    })
  })
})
