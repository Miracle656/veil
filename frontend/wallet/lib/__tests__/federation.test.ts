import { resolveFederation } from '../federation'

const CACHE_TTL_MS = 60_000

describe('resolveFederation cache', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-10-15T12:00:00.000Z'))
  })

  afterEach(() => {
    global.fetch = originalFetch
    jest.useRealTimers()
  })

  it('refreshes the resolved account after the short cache lifetime', async () => {
    const firstOwner = { account_id: 'G_FIRST_OWNER' }
    const currentOwner = { account_id: 'G_CURRENT_OWNER' }
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => 'FEDERATION_SERVER = "https://federation.example/federation"',
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => firstOwner })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => 'FEDERATION_SERVER = "https://federation.example/federation"',
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => currentOwner })
    global.fetch = fetchMock as unknown as typeof fetch

    await expect(resolveFederation('figure*useveilapp.xyz')).resolves.toEqual(firstOwner)
    await expect(resolveFederation('figure*useveilapp.xyz')).resolves.toEqual(firstOwner)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    jest.advanceTimersByTime(CACHE_TTL_MS - 1)
    await expect(resolveFederation('figure*useveilapp.xyz')).resolves.toEqual(firstOwner)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    jest.advanceTimersByTime(1)
    await expect(resolveFederation('figure*useveilapp.xyz')).resolves.toEqual(currentOwner)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})
