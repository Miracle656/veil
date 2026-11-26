/**
 * @jest-environment node
 *
 * lib/currency.ts under server rendering, where `window` does not exist.
 *
 * This cannot live in the jsdom file: jsdom's global `window` is
 * non-configurable, so `typeof window === 'undefined'` — the branch that keeps
 * the server and client markups identical — is unreachable there. Running this
 * file in the node environment is what actually exercises it.
 *
 * What breaks if these fail: a server render that read storage or started an FX
 * fetch would (a) differ from the first client render and produce a hydration
 * mismatch on every visit with a non-default currency, and (b) attempt a
 * network call during SSR.
 */

type CurrencyModule = typeof import('../currency')

const mockSyncStore = jest.fn(
  (
    _subscribe: (listener: () => void) => () => void,
    getSnapshot: () => number,
    getServerSnapshot: () => number,
  ) => getServerSnapshot(),
)

jest.mock('react', () => ({ useSyncExternalStore: mockSyncStore }))

const globalScope = globalThis as unknown as { fetch?: unknown }
const realFetch = globalScope.fetch

function loadCurrency(): CurrencyModule {
  let loaded!: CurrencyModule
  jest.isolateModules(() => {
    loaded = require('../currency') as CurrencyModule
  })
  return loaded
}

function stubFetch(): jest.Mock {
  const fn = jest.fn(async () => ({ ok: false }))
  globalScope.fetch = fn
  return fn
}

beforeEach(() => {
  stubFetch()
})

afterEach(() => {
  globalScope.fetch = realFetch
  jest.restoreAllMocks()
})

describe('currency.ts without a window', () => {
  it('really is running without a window', () => {
    // Guard the guard: if the environment ever gains a window, the assertions
    // below would silently start testing the browser path instead.
    expect(typeof window).toBe('undefined')
  })

  it('renders the default currency, so the first client render matches', () => {
    const mod = loadCurrency()
    mod.setCurrency('NGN')

    expect(mod.useCurrency()).toEqual({ code: 'USD', rate: 1, live: false })
  })

  it('hydrateCurrency is a no-op: no storage read, no FX fetch', () => {
    const fetchMock = stubFetch()
    const mod = loadCurrency()

    expect(() => mod.hydrateCurrency()).not.toThrow()
    expect(mod.getCurrency()).toBe('USD')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('setCurrency still applies in memory when there is nowhere to persist', () => {
    const mod = loadCurrency()

    // The write is attempted against an absent window and throws; that must be
    // swallowed, because losing the preference is not worth losing the click.
    expect(() => mod.setCurrency('GHS')).not.toThrow()
    expect(mod.getCurrency()).toBe('GHS')
  })

  it('prices from the bundled fallbacks before any fetch', () => {
    const mod = loadCurrency()
    expect(mod.areRatesLive()).toBe(false)
    expect(mod.getRate('NGN')).toBe(1600)
    expect(mod.formatFiat(1, 'NGN', null)).toBe('₦1,600')
  })
})
