/// <reference types="jest" />

import {
  FIXTURE_NFTS,
  fetchWalletNFTs,
  formatTokenId,
  truncateAddress,
  NFTItem,
} from '../nfts'

describe('Soroban CAP-46 NFT Module', () => {
  describe('FIXTURE_NFTS', () => {
    it('contains at least one fixture NFT', () => {
      expect(FIXTURE_NFTS.length).toBeGreaterThanOrEqual(1)
    })

    it('each fixture has required CAP-46 fields (name, image, attributes, standard)', () => {
      for (const item of FIXTURE_NFTS) {
        expect(item.name).toBeTruthy()
        expect(item.image).toBeTruthy()
        expect(item.standard).toBe('CAP-46')
        expect(Array.isArray(item.attributes)).toBe(true)
        expect(item.attributes.length).toBeGreaterThan(0)
        expect(item.isFixture).toBe(true)
      }
    })
  })

  describe('truncateAddress', () => {
    it('truncates a long Soroban contract address correctly', () => {
      const address = 'CBY3K4GENESISCAP46NFTX7V2QZP3M9L0K8J1H5G2F4D6S8A'
      const truncated = truncateAddress(address, 6, 6)
      expect(truncated).toBe('CBY3K4…4D6S8A')
    })

    it('returns short addresses unchanged', () => {
      expect(truncateAddress('C123')).toBe('C123')
      expect(truncateAddress('')).toBe('')
    })
  })

  describe('formatTokenId', () => {
    it('formats numeric token IDs with leading hash', () => {
      expect(formatTokenId(1)).toBe('#1')
      expect(formatTokenId(42)).toBe('#42')
    })

    it('handles string token IDs correctly', () => {
      expect(formatTokenId('777')).toBe('#777')
      expect(formatTokenId('#100')).toBe('#100')
    })
  })

  describe('fetchWalletNFTs', () => {
    it('throws error when indexer fetch fails and fixtures are not enabled', async () => {
      const originalFetch = global.fetch
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response)

      await expect(
        fetchWalletNFTs('GTESTWALLETADDRESS12345', { includeFixtures: false })
      ).rejects.toThrow('Indexer HTTP 500: Internal Server Error')

      global.fetch = originalFetch
    })

    it('returns fixture NFTs when includeFixtures is explicitly true', async () => {
      const originalFetch = global.fetch
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      } as Response)

      const nfts = await fetchWalletNFTs('GTESTWALLETADDRESS12345', { includeFixtures: true })
      expect(nfts.length).toBeGreaterThanOrEqual(1)
      expect(nfts.some((n: NFTItem) => n.isFixture)).toBe(true)

      global.fetch = originalFetch
    })

    it('never overwrites fixture owner with connected wallet address', async () => {
      const originalFetch = global.fetch
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      } as Response)

      const connectedWallet = 'GCONNECTED_WALLET_ADDRESS_999'
      const nfts = await fetchWalletNFTs(connectedWallet, { includeFixtures: true })
      const fixture = nfts.find(n => n.id === FIXTURE_NFTS[0].id)
      expect(fixture?.owner).toBe(FIXTURE_NFTS[0].owner)
      expect(fixture?.owner).not.toBe(connectedWallet)

      global.fetch = originalFetch
    })

    it('filters CAP-46 transfers when Wraith responds with token transfers', async () => {
      const mockTransfers = [
        {
          id: 101,
          contractId: 'CCAP46CONTRACTADDRESS12345',
          tokenId: '888',
          name: 'Test On-Chain CAP-46 NFT',
          standard: 'CAP-46',
          image: 'https://example.com/nft.png',
          attributes: [{ trait_type: 'Rarity', value: 'Epic' }],
          owner: 'GTESTWALLETADDRESS12345',
        },
        {
          id: 102,
          contractId: 'CSACCONTRACTNONNFT',
          amount: '1000',
          type: 'sac_transfer',
        },
      ]

      const originalFetch = global.fetch
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => mockTransfers,
      } as Response)

      const nfts = await fetchWalletNFTs('GTESTWALLETADDRESS12345', { includeFixtures: false })
      expect(nfts.length).toBe(1)
      expect(nfts[0].name).toBe('Test On-Chain CAP-46 NFT')
      expect(nfts[0].standard).toBe('CAP-46')
      expect(nfts[0].tokenId).toBe('888')
      expect(nfts[0].owner).toBe('GTESTWALLETADDRESS12345')

      global.fetch = originalFetch
    })

    it('returns empty list if includeFixtures is false and no on-chain NFTs exist (Empty State test)', async () => {
      const originalFetch = global.fetch
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      } as Response)

      const nfts = await fetchWalletNFTs('GTESTWALLETADDRESS12345', { includeFixtures: false })
      expect(nfts).toEqual([])

      global.fetch = originalFetch
    })
  })
})
