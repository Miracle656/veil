import {
  resolveFederation,
  clearFederationCache,
  invalidateFederationCache,
  DEFAULT_FEDERATION_CACHE_TTL_MS,
} from '../federation'

describe('federation resolver cache TTL (Issue #1071)', () => {
  const INITIAL_HOLDER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  const NEW_HOLDER = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

  beforeEach(() => {
    clearFederationCache()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('uses a 60-second default cache TTL', () => {
    expect(DEFAULT_FEDERATION_CACHE_TTL_MS).toBe(60_000)
  })

  it('re-fetches a resolution older than the TTL by moving the clock rather than sleeping', async () => {
    let holder = INITIAL_HOLDER
    const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('.well-known/stellar.toml')) {
        return {
          ok: true,
          text: async () => 'FEDERATION_SERVER="https://app.useveilapp.xyz/api/federation"',
        } as Response
      }
      return {
        ok: true,
        json: async () => ({ account_id: holder }),
      } as Response
    }) as unknown as typeof fetch

    // 1. Initial resolution queries network
    const res1 = await resolveFederation('alice*useveilapp.xyz', { fetchImpl: mockFetch })
    expect(res1.account_id).toBe(INITIAL_HOLDER)
    expect(mockFetch).toHaveBeenCalledTimes(2) // toml + federation endpoint

    // 2. Query within 60-second TTL returns cached hit without re-fetching
    jest.advanceTimersByTime(30_000) // move clock ahead 30 seconds
    const res2 = await resolveFederation('alice*useveilapp.xyz', { fetchImpl: mockFetch })
    expect(res2.account_id).toBe(INITIAL_HOLDER)
    expect(mockFetch).toHaveBeenCalledTimes(2) // no additional fetch

    // 3. Holder changes on-chain and clock moves past TTL
    holder = NEW_HOLDER
    jest.advanceTimersByTime(31_000) // total 61s past initial resolution

    // 4. Query after TTL expired re-queries network and reflects new holder
    const res3 = await resolveFederation('alice*useveilapp.xyz', { fetchImpl: mockFetch })
    expect(res3.account_id).toBe(NEW_HOLDER)
    expect(mockFetch).toHaveBeenCalledTimes(4) // 2 additional network requests
  })

  it('resolves a name whose holder changed to the new holder on the next lookup after invalidation', async () => {
    let holder = INITIAL_HOLDER
    const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('.well-known/stellar.toml')) {
        return {
          ok: true,
          text: async () => 'FEDERATION_SERVER="https://app.useveilapp.xyz/api/federation"',
        } as Response
      }
      return {
        ok: true,
        json: async () => ({ account_id: holder }),
      } as Response
    }) as unknown as typeof fetch

    await resolveFederation('alice*useveilapp.xyz', { fetchImpl: mockFetch })
    expect(mockFetch).toHaveBeenCalledTimes(2)

    // Token transfers to new holder and wallet triggers explicit invalidation
    holder = NEW_HOLDER
    invalidateFederationCache('alice*useveilapp.xyz')

    const res = await resolveFederation('alice*useveilapp.xyz', { fetchImpl: mockFetch })
    expect(res.account_id).toBe(NEW_HOLDER)
    expect(mockFetch).toHaveBeenCalledTimes(4)
  })

  it('does NOT serve a stale hit when a server error occurs after cache expiry', async () => {
    let returnError = false
    const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('.well-known/stellar.toml')) {
        return {
          ok: true,
          text: async () => 'FEDERATION_SERVER="https://app.useveilapp.xyz/api/federation"',
        } as Response
      }
      if (returnError) {
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
        } as Response
      }
      return {
        ok: true,
        json: async () => ({ account_id: INITIAL_HOLDER }),
      } as Response
    }) as unknown as typeof fetch

    // Initial successful resolution
    const res1 = await resolveFederation('bob*useveilapp.xyz', { fetchImpl: mockFetch })
    expect(res1.account_id).toBe(INITIAL_HOLDER)

    // Move clock past TTL (60s)
    jest.advanceTimersByTime(65_000)

    // Server now experiences an outage
    returnError = true

    // Must throw an error and never fall back to the stale hit
    await expect(
      resolveFederation('bob*useveilapp.xyz', { fetchImpl: mockFetch }),
    ).rejects.toThrow('federation server unreachable')
  })

  it('supports skipCache option to force immediate live resolution', async () => {
    let holder = INITIAL_HOLDER
    const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('.well-known/stellar.toml')) {
        return {
          ok: true,
          text: async () => 'FEDERATION_SERVER="https://app.useveilapp.xyz/api/federation"',
        } as Response
      }
      return {
        ok: true,
        json: async () => ({ account_id: holder }),
      } as Response
    }) as unknown as typeof fetch

    const res1 = await resolveFederation('carol*useveilapp.xyz', { fetchImpl: mockFetch })
    expect(res1.account_id).toBe(INITIAL_HOLDER)

    holder = NEW_HOLDER
    const res2 = await resolveFederation('carol*useveilapp.xyz', {
      fetchImpl: mockFetch,
      skipCache: true,
    })
    expect(res2.account_id).toBe(NEW_HOLDER)
  })
})
