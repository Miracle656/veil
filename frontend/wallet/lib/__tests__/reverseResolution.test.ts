import {
  resolveReverseName,
  formatAddressOrName,
  clearReverseCache,
  invalidateReverseCache,
  DEFAULT_REVERSE_TTL_MS,
} from '../reverseResolution'

describe('Reverse Federation Resolution (Issue #1076)', () => {
  const KNOWN_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  const UNKNOWN_ADDRESS = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
  const BOUND_NAME = 'jack*useveilapp.xyz'

  beforeEach(() => {
    clearReverseCache()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('uses 60-second default TTL', () => {
    expect(DEFAULT_REVERSE_TTL_MS).toBe(60_000)
  })

  it('resolves a registered address to its federation name (Resolved)', async () => {
    const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      expect(url).toContain('type=id')
      expect(url).toContain(encodeURIComponent(KNOWN_ADDRESS))
      return {
        ok: true,
        json: async () => ({
          stellar_address: BOUND_NAME,
          account_id: KNOWN_ADDRESS,
        }),
      } as Response
    }) as unknown as typeof fetch

    const name = await resolveReverseName(KNOWN_ADDRESS, { fetchImpl: mockFetch })
    expect(name).toBe(BOUND_NAME)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    // Cached lookup within TTL
    jest.advanceTimersByTime(30_000)
    const cachedName = await resolveReverseName(KNOWN_ADDRESS, { fetchImpl: mockFetch })
    expect(cachedName).toBe(BOUND_NAME)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('returns null for an address with no name and renders exactly as address (Unresolved)', async () => {
    const mockFetch = jest.fn(async () => {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as Response
    }) as unknown as typeof fetch

    const name = await resolveReverseName(UNKNOWN_ADDRESS, { fetchImpl: mockFetch })
    expect(name).toBeNull()

    // formatAddressOrName renders fallback formatting untouched
    const truncated = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-6)}`
    const rendered = formatAddressOrName(UNKNOWN_ADDRESS, name, truncated)
    expect(rendered).toBe('GBBBBB…BBBBBB')
  })

  it('gracefully returns null during a resolver outage without throwing (Resolver Outage)', async () => {
    const mockFetch = jest.fn(async () => {
      return {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response
    }) as unknown as typeof fetch

    // Server error returns null, avoiding crash or false guesses
    const name = await resolveReverseName(KNOWN_ADDRESS, { fetchImpl: mockFetch })
    expect(name).toBeNull()

    const truncated = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-6)}`
    expect(formatAddressOrName(KNOWN_ADDRESS, name, truncated)).toBe('GAAAAA…AAAAAA')
  })

  it('handles network exceptions gracefully during resolver outage', async () => {
    const mockFetch = jest.fn(async () => {
      throw new Error('Network offline')
    }) as unknown as typeof fetch

    const name = await resolveReverseName(KNOWN_ADDRESS, { fetchImpl: mockFetch })
    expect(name).toBeNull()
  })

  it('reflects name changes on token transfer after cache expiry or invalidation', async () => {
    let currentName = 'jack*useveilapp.xyz'
    const mockFetch = jest.fn(async () => {
      return {
        ok: true,
        json: async () => ({
          stellar_address: currentName,
          account_id: KNOWN_ADDRESS,
        }),
      } as Response
    }) as unknown as typeof fetch

    const name1 = await resolveReverseName(KNOWN_ADDRESS, { fetchImpl: mockFetch })
    expect(name1).toBe('jack*useveilapp.xyz')

    // Name moves / changes
    currentName = 'jack-new*useveilapp.xyz'
    invalidateReverseCache(KNOWN_ADDRESS)

    const name2 = await resolveReverseName(KNOWN_ADDRESS, { fetchImpl: mockFetch })
    expect(name2).toBe('jack-new*useveilapp.xyz')
  })
})
