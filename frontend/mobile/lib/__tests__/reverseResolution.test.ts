import {
  resolveReverseName,
  formatAddressOrName,
  clearReverseCache,
  invalidateReverseCache,
  DEFAULT_REVERSE_TTL_MS,
} from '../reverseResolution'

describe('Mobile Reverse Federation Resolution (Issue #1076)', () => {
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

  it('resolves address to name for mobile feed', async () => {
    const mockFetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ stellar_address: BOUND_NAME, account_id: KNOWN_ADDRESS }),
    })) as unknown as typeof fetch

    const name = await resolveReverseName(KNOWN_ADDRESS, { fetchImpl: mockFetch })
    expect(name).toBe(BOUND_NAME)
  })

  it('keeps raw address when unresolved', async () => {
    const mockFetch = jest.fn(async () => ({
      ok: false,
      status: 404,
    })) as unknown as typeof fetch

    const name = await resolveReverseName(UNKNOWN_ADDRESS, { fetchImpl: mockFetch })
    expect(name).toBeNull()

    const formatted = formatAddressOrName(UNKNOWN_ADDRESS, name, (a) => `${a.slice(0, 6)}…${a.slice(-6)}`)
    expect(formatted).toBe('GBBBBB…BBBBBB')
  })

  it('safely handles resolver outage without throwing', async () => {
    const mockFetch = jest.fn(async () => ({
      ok: false,
      status: 503,
    })) as unknown as typeof fetch

    const name = await resolveReverseName(KNOWN_ADDRESS, { fetchImpl: mockFetch })
    expect(name).toBeNull()
  })
})
