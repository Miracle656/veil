/**
 * @jest-environment node
 */

import { fetchWalletNFTs, type IndexerFreshness } from '../nfts'

const WALLET = 'GAE6BEVEA6IH4HLTGU3AEGZZWSLNCCWLKD4GLN2XHLXFFNFB24COWUJY'
const BASE = 'https://wraith.example'

/**
 * The gallery told the owner of the first Veil-ian that they held no NFTs,
 * minutes after the chain recorded the mint. The token was real; the mainnet
 * indexer had never started, and an empty `transfers` array from a dead
 * indexer is indistinguishable from an empty wallet unless the flags beside it
 * are read.
 */
function reply(body: unknown) {
  return jest.fn(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch
}

describe('indexer freshness is reported, not swallowed', () => {
  it('reports a stopped indexer rather than an empty wallet', async () => {
    const seen: IndexerFreshness[] = []
    const items = await fetchWalletNFTs(WALLET, {
      wraithUrl: BASE,
      network: 'mainnet',
      fetchImpl: reply({ transfers: [], stale: true, indexer_running: false }),
      onStale: (m) => seen.push(m),
    })

    expect(items).toEqual([])
    expect(seen).toHaveLength(1)
    expect(seen[0].running).toBe(false)
    expect(seen[0].stale).toBe(true)
  })

  it('reports a lagging-but-running indexer, with the ledger it reached', async () => {
    const seen: IndexerFreshness[] = []
    await fetchWalletNFTs(WALLET, {
      wraithUrl: BASE,
      network: 'mainnet',
      fetchImpl: reply({ transfers: [], stale: true, as_of_ledger: 65_404_000 }),
      onStale: (m) => seen.push(m),
    })

    expect(seen[0]).toEqual({ stale: true, running: true, asOfLedger: 65_404_000 })
  })

  it('says nothing when the indexer is healthy and the wallet is simply empty', async () => {
    // The distinction only earns its keep if the healthy case stays quiet —
    // a warning on every empty gallery is a warning nobody reads.
    const seen: IndexerFreshness[] = []
    const items = await fetchWalletNFTs(WALLET, {
      wraithUrl: BASE,
      network: 'mainnet',
      fetchImpl: reply({ transfers: [] }),
      onStale: (m) => seen.push(m),
    })

    expect(items).toEqual([])
    expect(seen).toHaveLength(0)
  })

  it('does not require the caller to pass a handler', async () => {
    await expect(
      fetchWalletNFTs(WALLET, {
        wraithUrl: BASE,
        network: 'mainnet',
        fetchImpl: reply({ transfers: [], stale: true, indexer_running: false }),
      }),
    ).resolves.toEqual([])
  })
})
