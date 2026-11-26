import {
  resolveFederation,
  clearFederationCache,
  invalidateFederationCache,
  DEFAULT_FEDERATION_CACHE_TTL_MS,
} from '../federation'

describe('mobile federation cache TTL (Issue #1071)', () => {
  const INITIAL_HOLDER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  const NEW_HOLDER = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

  beforeEach(() => {
    clearFederationCache()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('uses 60-second TTL identical to web wallet', () => {
    expect(DEFAULT_FEDERATION_CACHE_TTL_MS).toBe(60_000)
  })

  it('re-fetches after TTL moves forward rather than sleeping', async () => {
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

    const res1 = await resolveFederation('user*useveilapp.xyz', { fetchImpl: mockFetch })
    expect(res1.account_id).toBe(INITIAL_HOLDER)
    expect(mockFetch).toHaveBeenCalledTimes(2)

    // Advance clock within TTL
    jest.advanceTimersByTime(30_000)
    const res2 = await resolveFederation('user*useveilapp.xyz', { fetchImpl: mockFetch })
    expect(res2.account_id).toBe(INITIAL_HOLDER)
    expect(mockFetch).toHaveBeenCalledTimes(2)

    // Advance past TTL and transfer
    holder = NEW_HOLDER
    jest.advanceTimersByTime(31_000)

    const res3 = await resolveFederation('user*useveilapp.xyz', { fetchImpl: mockFetch })
    expect(res3.account_id).toBe(NEW_HOLDER)
    expect(mockFetch).toHaveBeenCalledTimes(4)
  })

  it('never serves a stale hit on server failure after expiry', async () => {
    let fail = false
    const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('.well-known/stellar.toml')) {
        return {
          ok: true,
          text: async () => 'FEDERATION_SERVER="https://app.useveilapp.xyz/api/federation"',
        } as Response
      }
      if (fail) {
        return {
          ok: false,
          status: 502,
        } as Response
      }
      return {
        ok: true,
        json: async () => ({ account_id: INITIAL_HOLDER }),
      } as Response
    }) as unknown as typeof fetch

    await resolveFederation('test*useveilapp.xyz', { fetchImpl: mockFetch })

    // Move clock past TTL
    jest.advanceTimersByTime(65_000)
    fail = true

    await expect(
      resolveFederation('test*useveilapp.xyz', { fetchImpl: mockFetch }),
    ).rejects.toThrow('federation server unreachable')
  })
})
