/** @jest-environment node */

import {
  PUBLIC_MAINNET_RPCS,
  forwardWithFailover,
  isProviderRefusal,
  mainnetUpstreams,
} from '../rpcFailover'
import { ALLOWED_METHODS, SPP_REQUIRED_METHODS, disallowedMethod } from '@/lib/rpcAllowlist'
import { GET } from '@/app/api/rpc/mainnet/route'

function reply(status: number, body: unknown) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('mainnetUpstreams', () => {
  it('puts configured endpoints first, then the public ones, without duplicates', () => {
    const list = mainnetUpstreams({
      MAINNET_RPC_URL: 'https://paid.example/key',
      MAINNET_RPC_URLS: 'https://second.example, https://rpc.lightsail.network',
    })
    expect(list.slice(0, 2)).toEqual(['https://paid.example/key', 'https://second.example'])
    expect(list.filter((u) => u === 'https://rpc.lightsail.network')).toHaveLength(1)
    expect(list).toEqual(expect.arrayContaining([...PUBLIC_MAINNET_RPCS]))
  })

  it('works with nothing configured', () => {
    expect(mainnetUpstreams({})).toEqual([...PUBLIC_MAINNET_RPCS])
  })

  it('can turn the public fallback off', () => {
    expect(mainnetUpstreams({ MAINNET_RPC_URL: 'https://paid.example', MAINNET_RPC_PUBLIC_FALLBACK: 'off' })).toEqual([
      'https://paid.example',
    ])
  })
})

describe('isProviderRefusal', () => {
  it.each([401, 403, 429, 500, 502, 503])('treats HTTP %i as the provider refusing', (status) => {
    expect(isProviderRefusal(status, '')).toBe(true)
  })

  it('treats a quota or expired-plan error inside a 200 as a refusal', () => {
    expect(isProviderRefusal(200, JSON.stringify({ error: { code: -32001, message: 'Endpoint disabled: trial expired' } }))).toBe(true)
  })

  it('returns an error about the request itself, which any provider would repeat', () => {
    expect(isProviderRefusal(200, JSON.stringify({ error: { code: -32602, message: 'invalid parameters' } }))).toBe(false)
    expect(isProviderRefusal(400, 'bad request')).toBe(false)
  })
})

describe('forwardWithFailover', () => {
  const ok = { jsonrpc: '2.0', id: 1, result: { status: 'healthy' } }

  it('uses the first provider when it answers', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, ok))
    const result = await forwardWithFailover(['a', 'b'], '{}', fetchImpl)
    expect(result?.upstreamIndex).toBe(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('moves on when a provider is unreachable, rate limited, or its plan has lapsed', async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(reply(429, 'slow down'))
      .mockResolvedValueOnce(reply(200, { error: { message: 'API key expired' } }))
      .mockResolvedValueOnce(reply(200, ok))
    const result = await forwardWithFailover(['a', 'b', 'c', 'd'], '{}', fetchImpl)
    expect(result?.upstreamIndex).toBe(3)
    expect(JSON.parse(result!.body)).toEqual(ok)
  })

  it('does not retry an answer about the transaction', async () => {
    const txError = { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'invalid transaction envelope' } }
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, txError))
    const result = await forwardWithFailover(['a', 'b'], '{}', fetchImpl)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result?.upstreamIndex).toBe(0)
  })

  it('passes on the last refusal when every provider refuses', async () => {
    // A fresh Response per call: a body can only be read once.
    const fetchImpl = jest.fn().mockImplementation(async () => reply(429, 'slow down'))
    const result = await forwardWithFailover(['a', 'b'], '{}', fetchImpl)
    expect(result?.status).toBe(429)
    expect(result?.upstreamIndex).toBe(1)
  })

  it('returns null when nothing can be reached', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('offline'))
    await expect(forwardWithFailover(['a', 'b'], '{}', fetchImpl)).resolves.toBeNull()
  })
})

describe('spp rpc coverage (V133)', () => {
  it.each([...SPP_REQUIRED_METHODS])('proxies the SPP method %s', (method) => {
    expect(ALLOWED_METHODS.has(method)).toBe(true)
    expect(disallowedMethod({ jsonrpc: '2.0', id: 1, method })).toBeNull()
  })

  it('proxies a batched SPP sync payload (getLatestLedger + getEvents + getLedgerEntries)', () => {
    const payload = [
      { jsonrpc: '2.0', id: 1, method: 'getLatestLedger', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'getEvents', params: { filters: [], pagination: { limit: 100 } } },
      { jsonrpc: '2.0', id: 3, method: 'getLedgerEntries', params: { keys: [] } },
    ]
    expect(disallowedMethod(payload)).toBeNull()
  })

  it('proxies the SPP transact sequence (simulate + send + confirm)', () => {
    const payload = [
      { jsonrpc: '2.0', id: 1, method: 'simulateTransaction', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'sendTransaction', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'getTransaction', params: {} },
    ]
    expect(disallowedMethod(payload)).toBeNull()
  })

  it('still rejects testnet-only and unknown methods (requestAirdrop, getLedgers)', () => {
    expect(disallowedMethod({ jsonrpc: '2.0', id: 1, method: 'requestAirdrop' })).toBe('requestAirdrop')
    expect(disallowedMethod({ jsonrpc: '2.0', id: 1, method: 'getLedgers' })).toBe('getLedgers')
    expect(
      disallowedMethod([
        { jsonrpc: '2.0', id: 1, method: 'getEvents' },
        { jsonrpc: '2.0', id: 2, method: 'requestAirdrop' },
      ]),
    ).toBe('requestAirdrop')
  })

  it('scans events through each public upstream in order', async () => {
    const scanBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getEvents',
      params: { startLedger: 1, filters: [], pagination: { limit: 100 } },
    })
    const page = { jsonrpc: '2.0', id: 1, result: { events: [], latestLedger: 2 } }
    const fetchImpl = jest.fn().mockImplementation(async (url: string) => {
      if (url !== PUBLIC_MAINNET_RPCS[PUBLIC_MAINNET_RPCS.length - 1]) {
        throw new Error('unreachable')
      }
      return reply(200, page)
    })
    const result = await forwardWithFailover([...PUBLIC_MAINNET_RPCS], scanBody, fetchImpl)
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([...PUBLIC_MAINNET_RPCS])
    expect(fetchImpl.mock.calls.every(([, init]) => (init as RequestInit).body === scanBody)).toBe(true)
    expect(result?.upstreamIndex).toBe(PUBLIC_MAINNET_RPCS.length - 1)
    expect(JSON.parse(result!.body)).toEqual(page)
  })

  it('GET exposes counts only, never upstream URLs or keys', async () => {
    const response = await GET()
    const body = await response.json()
    expect(Object.keys(body).sort()).toEqual(['configured', 'upstreams'])
    expect(typeof body.configured).toBe('boolean')
    expect(typeof body.upstreams).toBe('number')
    expect(JSON.stringify(body)).not.toMatch(/https?:\/\//)
  })
})
