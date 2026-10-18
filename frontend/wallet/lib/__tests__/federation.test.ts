/// <reference types="jest" />

import {
  DEFAULT_FEDERATION_CACHE_TTL_MS,
  clearFederationCache,
  invalidateFederationCache,
  resolveFederation,
} from '../federation'
import {
  NameNotFoundError,
  UnreadableHolderError,
  resolveFederationId,
  resolveFederationName,
} from '../namesResolver'

const INITIAL_HOLDER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWLT'
const NEW_HOLDER     = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBOTHR'

describe('federation resolution (Issue #1075)', () => {
  beforeEach(() => {
    clearFederationCache()
  })

  describe('resolveFederationName & on-chain holder resolution', () => {
    it('a name resolves to the current holder, and to the new one after a transfer', async () => {
      let currentOnChainHolder = INITIAL_HOLDER

      const mockReader = jest.fn(async () => currentOnChainHolder)

      // 1. Initial resolution: resolves to current on-chain holder
      const res1 = await resolveFederationName('alice*useveilapp.xyz', {
        chainReader: mockReader,
      })
      expect(res1.account_id).toBe(INITIAL_HOLDER)
      expect(res1.stellar_address).toBe('alice*useveilapp.xyz')

      // 2. Token is transferred on-chain
      currentOnChainHolder = NEW_HOLDER

      // 3. New resolution: resolves dynamically to the new holder
      const res2 = await resolveFederationName('alice*useveilapp.xyz', {
        chainReader: mockReader,
      })
      expect(res2.account_id).toBe(NEW_HOLDER)
      expect(res2.stellar_address).toBe('alice*useveilapp.xyz')
    })

    it('returns a SEP-2 compliant response shape', async () => {
      const mockReader = jest.fn(async () => INITIAL_HOLDER)

      const res = await resolveFederationName('alice*useveilapp.xyz', {
        chainReader: mockReader,
      })

      // SEP-2 requirement: object with stellar_address and account_id
      expect(res).toHaveProperty('account_id', INITIAL_HOLDER)
      expect(res).toHaveProperty('stellar_address', 'alice*useveilapp.xyz')
      expect(typeof res.account_id).toBe('string')
      expect(res.account_id.startsWith('G')).toBe(true)
    })

    it('an unreadable holder is an error, never a stale address', async () => {
      const failingReader = jest.fn(async () => {
        throw new Error('RPC connection dropped: node unreachable')
      })

      await expect(
        resolveFederationName('alice*useveilapp.xyz', { chainReader: failingReader }),
      ).rejects.toThrow(UnreadableHolderError)

      await expect(
        resolveFederationName('alice*useveilapp.xyz', { chainReader: failingReader }),
      ).rejects.toThrow('Cannot determine current on-chain holder for "alice"')
    })

    it('throws NameNotFoundError when name does not exist in registry', async () => {
      await expect(
        resolveFederationName('nonexistent*useveilapp.xyz', {
          chainReader: jest.fn(async () => null),
        }),
      ).rejects.toThrow(NameNotFoundError)
    })
  })

  describe('resolveFederationId (reverse lookup)', () => {
    it('resolves account_id to the name currently held by that account', async () => {
      const mockReader = jest.fn(async (_contract, tokenId) => {
        return tokenId === '1' ? INITIAL_HOLDER : NEW_HOLDER
      })

      const res = await resolveFederationId(INITIAL_HOLDER, {
        chainReader: mockReader,
      })

      expect(res.account_id).toBe(INITIAL_HOLDER)
      expect(res.stellar_address).toBe('alice*useveilapp.xyz')
    })
  })

  describe('client-side cache TTL in federation.ts', () => {
    it('uses a 60-second default cache TTL', () => {
      expect(DEFAULT_FEDERATION_CACHE_TTL_MS).toBe(60_000)
    })

    it('returns cached result before TTL expires', async () => {
      const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('.well-known/stellar.toml')) {
          return {
            ok: true,
            text: async () => 'FEDERATION_SERVER="https://test.example.com/api/federation"',
          } as Response
        }
        return {
          ok: true,
          json: async () => ({ account_id: INITIAL_HOLDER }),
        } as Response
      }) as unknown as typeof fetch

      // First query queries the network
      const res1 = await resolveFederation('user*domain.com', { fetchImpl: mockFetch })
      expect(res1.account_id).toBe(INITIAL_HOLDER)
      expect(mockFetch).toHaveBeenCalledTimes(2) // toml + query

      // Second query within TTL uses cache without network calls
      const res2 = await resolveFederation('user*domain.com', { fetchImpl: mockFetch })
      expect(res2.account_id).toBe(INITIAL_HOLDER)
      expect(mockFetch).toHaveBeenCalledTimes(2) // no additional fetch
    })

    it('re-queries the network when TTL expires, reflecting token transfers', async () => {
      let holder = INITIAL_HOLDER
      const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('.well-known/stellar.toml')) {
          return {
            ok: true,
            text: async () => 'FEDERATION_SERVER="https://test.example.com/api/federation"',
          } as Response
        }
        return {
          ok: true,
          json: async () => ({ account_id: holder }),
        } as Response
      }) as unknown as typeof fetch

      // Query with 10ms short TTL
      const res1 = await resolveFederation('user*domain.com', {
        ttlMs: 10,
        fetchImpl: mockFetch,
      })
      expect(res1.account_id).toBe(INITIAL_HOLDER)

      // Token transfers to new holder
      holder = NEW_HOLDER

      // Wait 15ms for TTL to expire
      await new Promise((r) => setTimeout(r, 15))

      // Resolution now queries server and reflects new holder
      const res2 = await resolveFederation('user*domain.com', {
        ttlMs: 10,
        fetchImpl: mockFetch,
      })
      expect(res2.account_id).toBe(NEW_HOLDER)
      expect(mockFetch).toHaveBeenCalledTimes(4) // 2 for first, 2 for expired second
    })

    it('allows explicit cache invalidation via invalidateFederationCache', async () => {
      let holder = INITIAL_HOLDER
      const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('.well-known/stellar.toml')) {
          return {
            ok: true,
            text: async () => 'FEDERATION_SERVER="https://test.example.com/api/federation"',
          } as Response
        }
        return {
          ok: true,
          json: async () => ({ account_id: holder }),
        } as Response
      }) as unknown as typeof fetch

      await resolveFederation('alice*domain.com', { fetchImpl: mockFetch })
      expect(mockFetch).toHaveBeenCalledTimes(2)

      // Invalidate specific address after transfer
      holder = NEW_HOLDER
      invalidateFederationCache('alice*domain.com')

      const res = await resolveFederation('alice*domain.com', { fetchImpl: mockFetch })
      expect(res.account_id).toBe(NEW_HOLDER)
      expect(mockFetch).toHaveBeenCalledTimes(4)
    })
  })
})
