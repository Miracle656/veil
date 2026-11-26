/**
 * @jest-environment jsdom
 *
 * lib/currency.ts is the module that decides what a user reads as "how much
 * money I have". Every assertion here is on the EXACT string, because the bugs
 * this file exists to stop are string bugs: a missing separator makes ₦1,600,000
 * read as ₦1600000 (a hundredfold error), a dropped decimal turns $12.34 into
 * $12, and rendering an unpriced balance as "₦0" tells a funded user they are
 * empty. "Contains a comma" would pass through all three.
 *
 * There is no crypto path in this module — it converts USD to a display
 * currency and formats fiat only — so unlike the mobile copy there is no second
 * rounding rule to cover here.
 *
 * The module is stateful (cached FX rates, the selected currency), so every test
 * that touches state loads a fresh copy via `jest.isolateModules` — otherwise
 * the live-rate test would silently change what the fallback-rate test sees.
 *
 * React is mocked to the single hook the module imports: `useCurrency` is a
 * thin read of module state, and the point of testing it is the snapshot
 * contract (`useSyncExternalStore` only re-renders when the snapshot changes,
 * and the server snapshot is pinned to a constant), not React's internals.
 */

import type { CurrencyCode } from '../currency'

type CurrencyModule = typeof import('../currency')

const mockSyncStore = jest.fn(
  (
    _subscribe: (listener: () => void) => () => void,
    getSnapshot: () => number,
    _getServerSnapshot: () => number,
  ) => getSnapshot(),
)

jest.mock('react', () => ({ useSyncExternalStore: mockSyncStore }))

/** A fresh module, so FX cache and selected currency start at their defaults. */
function loadCurrency(): CurrencyModule {
  let loaded!: CurrencyModule
  jest.isolateModules(() => {
    loaded = require('../currency') as CurrencyModule
  })
  return loaded
}

const globalScope = globalThis as unknown as { fetch?: unknown }

const realFetch = globalScope.fetch

/** Replace global fetch; returns the mock so the test can assert the call. */
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<unknown>): jest.Mock {
  const fn = jest.fn(impl)
  globalScope.fetch = fn
  return fn
}

/** A fetch that answers with a JSON body (or rejects while reading it). */
function jsonResponse(body: unknown): Promise<unknown> {
  return Promise.resolve({ ok: true, json: async () => body })
}

beforeEach(() => {
  localStorage.clear()
  mockSyncStore.mockClear()
  // No test may reach the network: hydrateCurrency fires a refresh, and a real
  // er-api call would make this file flaky rather than fail.
  stubFetch(async () => ({ ok: false }))
})

afterEach(() => {
  globalScope.fetch = realFetch
  jest.useRealTimers()
  jest.restoreAllMocks()
})

// ── formatFiat ───────────────────────────────────────────────────────────────

describe('formatFiat — naira (decimals: 0)', () => {
  it('writes seven figures with separators', () => {
    // Without the separator this reads as ₦1600000 — a hundredfold misreading.
    expect(loadCurrency().formatFiat(1000, 'NGN', 1600)).toBe('₦1,600,000')
  })

  it('writes a billion naira without losing a separator', () => {
    // The largest realistic balance must not fall into a different grouping.
    expect(loadCurrency().formatFiat(1_000_000, 'NGN', 1600)).toBe('₦1,600,000,000')
  })

  it('rounds kobo away, because NGN is configured with zero decimals', () => {
    // Naira has no minor unit on this screen: 0.5 USD is ₦800 exactly.
    expect(loadCurrency().formatFiat(0.5, 'NGN', 1600)).toBe('₦800')
    // 0.0004 USD = ₦0.64, which must round up rather than truncate to ₦0.
    expect(loadCurrency().formatFiat(0.0004, 'NGN', 1600)).toBe('₦1')
    // 0.0003 USD = ₦0.48, which must round down to ₦0 — not 0.48.
    expect(loadCurrency().formatFiat(0.0003, 'NGN', 1600)).toBe('₦0')
  })

  it('writes zero as ₦0', () => {
    expect(loadCurrency().formatFiat(0, 'NGN', 1600)).toBe('₦0')
  })

  it('writes a negative amount with the sign after the symbol', () => {
    // Asserted as-is: the symbol precedes the minus. If this shape changes it
    // should be because someone decided it, not because the separator moved.
    expect(loadCurrency().formatFiat(-5, 'NGN', 1600)).toBe('₦-8,000')
  })
})

describe('formatFiat — currencies with two decimals', () => {
  it('keeps the cents on USD', () => {
    expect(loadCurrency().formatFiat(1234.5, 'USD', 1)).toBe('$1,234.50')
  })

  it('keeps exactly two decimals on majors, rounding half up', () => {
    // A third decimal silently kept would show a sub-cent amount on screen.
    expect(loadCurrency().formatFiat(12.345, 'USD', 1)).toBe('$12.35')
    expect(loadCurrency().formatFiat(0.01, 'USD', 1)).toBe('$0.01')
    expect(loadCurrency().formatFiat(0, 'USD', 1)).toBe('$0.00')
    expect(loadCurrency().formatFiat(1234.5, 'GBP', 1)).toBe('£1,234.50')
    expect(loadCurrency().formatFiat(1, 'EUR', 1)).toBe('€1.00')
  })

  it('uses each currency\u2019s own symbol and precision', () => {
    expect(loadCurrency().formatFiat(100, 'GHS', 15)).toBe('₵1,500.00')
    expect(loadCurrency().formatFiat(100, 'ZAR', 18)).toBe('R1,800.00')
    // KES is configured with zero decimals, like NGN.
    expect(loadCurrency().formatFiat(100, 'KES', 129)).toBe('KSh12,900')
  })
})

describe('formatFiat — unpriced values', () => {
  it('returns an em dash for a null amount, never $0.00', () => {
    // "We could not price this" must not read as "you have nothing".
    expect(loadCurrency().formatFiat(null, 'USD', 1)).toBe('—')
    expect(loadCurrency().formatFiat(null, 'NGN', 1600)).toBe('—')
  })

  it('returns an em dash for amounts that are not finite numbers', () => {
    // NaN and ±Infinity have no money meaning; printing them would show
    // "$NaN" on a balance screen.
    expect(loadCurrency().formatFiat(NaN, 'USD', 1)).toBe('—')
    expect(loadCurrency().formatFiat(Infinity, 'USD', 1)).toBe('—')
    expect(loadCurrency().formatFiat(-Infinity, 'NGN', 1600)).toBe('—')
  })

  it('falls back to the bundled rate when the live rate is absent', () => {
    // An offline first paint must show a plausible figure, not a blank balance.
    expect(loadCurrency().formatFiat(1, 'NGN', null)).toBe('₦1,600')
    expect(loadCurrency().formatFiat(2, 'USD', null)).toBe('$2.00')
  })

  it('ignores a non-finite rate rather than printing ₦NaN', () => {
    // The live feed can hand back a garbage number; the bundled rate is the
    // defined result for a rate that cannot be used.
    expect(loadCurrency().formatFiat(10, 'NGN', NaN)).toBe('₦16,000')
    expect(loadCurrency().formatFiat(10, 'USD', Infinity)).toBe('$10.00')
  })

  it('falls back to USD formatting for a code that is not in the table', () => {
    // A stored or server-sent code outside the union must not format as
    // "undefined1,000" — it degrades to the default currency.
    const mod = loadCurrency()
    expect(mod.formatFiat(10, 'XYZ' as CurrencyCode, 2)).toBe('$20.00')
  })
})

// ── convertUsd ───────────────────────────────────────────────────────────────

describe('convertUsd', () => {
  it('multiplies a USD amount by the rate', () => {
    expect(loadCurrency().convertUsd(10, 1600)).toBe(16_000)
    expect(loadCurrency().convertUsd(2.5, 1)).toBe(2.5)
    expect(loadCurrency().convertUsd(0, 1600)).toBe(0)
  })

  it('returns null when either side is missing, never 0', () => {
    // A null balance multiplied to 0 would render as "you have nothing".
    expect(loadCurrency().convertUsd(null, 1600)).toBeNull()
    expect(loadCurrency().convertUsd(10, null)).toBeNull()
    expect(loadCurrency().convertUsd(null, null)).toBeNull()
  })

  it('returns null for non-finite inputs instead of NaN/Infinity', () => {
    const mod = loadCurrency()
    expect(mod.convertUsd(NaN, 1600)).toBeNull()
    expect(mod.convertUsd(Infinity, 1600)).toBeNull()
    expect(mod.convertUsd(-Infinity, 1600)).toBeNull()
    expect(mod.convertUsd(10, NaN)).toBeNull()
    expect(mod.convertUsd(10, Infinity)).toBeNull()
  })
})

// ── isCurrencyCode ───────────────────────────────────────────────────────────

describe('isCurrencyCode', () => {
  const load = () => loadCurrency()

  it('accepts every code the table declares', () => {
    const mod = load()
    for (const code of mod.CURRENCY_CODES) {
      expect(mod.isCurrencyCode(code)).toBe(true)
    }
  })

  it('refuses a code the table does not declare', () => {
    // A wrong code must not be stored and later read as a rate of undefined.
    const mod = load()
    expect(mod.isCurrencyCode('XYZ')).toBe(false)
    expect(mod.isCurrencyCode('ngn')).toBe(false)
    expect(mod.isCurrencyCode('')).toBe(false)
  })

  it('refuses non-string values', () => {
    const mod = load()
    expect(mod.isCurrencyCode(null)).toBe(false)
    expect(mod.isCurrencyCode(undefined)).toBe(false)
    expect(mod.isCurrencyCode(42)).toBe(false)
    expect(mod.isCurrencyCode({ code: 'NGN' })).toBe(false)
  })

  it('refuses inherited Object keys, which are not currencies', () => {
    // `in` walks the prototype chain: 'toString' and 'constructor' would pass
    // the check, get persisted, and resolve to a rate of undefined.
    const mod = load()
    expect(mod.isCurrencyCode('toString')).toBe(false)
    expect(mod.isCurrencyCode('constructor')).toBe(false)
    expect(mod.isCurrencyCode('hasOwnProperty')).toBe(false)
    expect(mod.isCurrencyCode('__proto__')).toBe(false)
  })

  it('pins the table the picker offers', () => {
    // Dropping or renaming a code here re-labels every balance in that currency.
    expect(load().CURRENCY_CODES).toEqual(['USD', 'NGN', 'KES', 'GHS', 'ZAR', 'GBP', 'EUR'])
    expect(load().DEFAULT_CURRENCY).toBe('USD')
    expect(load().CURRENCY_STORAGE_KEY).toBe('veil_currency')
  })
})

// ── Rates: cache, fetch, failure modes ───────────────────────────────────────

describe('getRate / areRatesLive before any fetch', () => {
  it('serves the bundled fallback for every currency', () => {
    // The first paint happens before the feed answers; a missing rate here
    // would leave the balance blank on a cold start.
    const mod = loadCurrency()
    expect(mod.getRate('USD')).toBe(1)
    expect(mod.getRate('NGN')).toBe(1600)
    expect(mod.getRate('KES')).toBe(129)
    expect(mod.getRate('GHS')).toBe(15)
    expect(mod.getRate('ZAR')).toBe(18)
    expect(mod.getRate('GBP')).toBe(0.79)
    expect(mod.getRate('EUR')).toBe(0.92)
    expect(mod.areRatesLive()).toBe(false)
  })
})

describe('refreshFxRates — failures leave the fallbacks standing', () => {
  it('returns false when fetch does not exist (SSR, old runtime)', () => {
    globalScope.fetch = undefined
    const mod = loadCurrency()
    return expect(mod.refreshFxRates()).resolves.toBe(false)
  })

  it('returns false on a non-ok response', async () => {
    stubFetch(async () => ({ ok: false, json: async () => ({ rates: { NGN: 1 } }) }))
    const mod = loadCurrency()
    await expect(mod.refreshFxRates()).resolves.toBe(false)
    // A 429 or 500 body must not be trusted just because it parsed.
    expect(mod.getRate('NGN')).toBe(1600)
    expect(mod.areRatesLive()).toBe(false)
  })

  it('returns false when the body has no rates object', async () => {
    const mod = loadCurrency()
    stubFetch(async () => ({ ok: true, json: async () => ({}) }))
    await expect(mod.refreshFxRates()).resolves.toBe(false)
    stubFetch(async () => ({ ok: true, json: async () => ({ rates: null }) }))
    await expect(mod.refreshFxRates()).resolves.toBe(false)
    stubFetch(async () => ({ ok: true, json: async () => ({ rates: 'NGN' }) }))
    await expect(mod.refreshFxRates()).resolves.toBe(false)
    expect(mod.areRatesLive()).toBe(false)
  })

  it('returns false when the body is not JSON at all (an edge holding page)', async () => {
    const mod = loadCurrency()
    stubFetch(() => Promise.resolve({ ok: true, json: async () => JSON.parse('<html>') }))
    await expect(mod.refreshFxRates()).resolves.toBe(false)
    expect(mod.areRatesLive()).toBe(false)
  })

  it('returns false when fetch rejects (offline)', async () => {
    const mod = loadCurrency()
    stubFetch(() => Promise.reject(new Error('network down')))
    await expect(mod.refreshFxRates()).resolves.toBe(false)
    expect(mod.getRate('NGN')).toBe(1600)
  })

  it('discards a rates payload where no value is usable', async () => {
    // Zero, negative, string and NaN rates are all unusable; a payload made
    // only of them must not be recorded as a successful fetch.
    const mod = loadCurrency()
    stubFetch(async () => jsonResponse({ rates: { NGN: 0, USD: -1, KES: '129', GHS: NaN } }))
    await expect(mod.refreshFxRates()).resolves.toBe(false)
    expect(mod.areRatesLive()).toBe(false)
    expect(mod.getRate('NGN')).toBe(1600)
  })

  it('aborts after five seconds rather than hanging the screen', async () => {
    jest.useFakeTimers()
    const mod = loadCurrency()
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted.')
            err.name = 'AbortError'
            reject(err)
          })
        }),
    )

    const pending = mod.refreshFxRates()
    await jest.advanceTimersByTimeAsync(5_000)

    await expect(pending).resolves.toBe(false)
    expect(mod.areRatesLive()).toBe(false)
  })
})

describe('refreshFxRates — success', () => {
  it('asks the documented endpoint and records only usable rates', async () => {
    const mod = loadCurrency()
    const fetchMock = stubFetch(async () =>
      jsonResponse({ rates: { NGN: 1_700, GHS: 17.5, KES: 0, USD: 1 } }),
    )

    await expect(mod.refreshFxRates()).resolves.toBe(true)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://open.er-api.com/v6/latest/USD',
      expect.objectContaining({ signal: expect.anything() }),
    )
    expect(mod.areRatesLive()).toBe(true)
    expect(mod.getRate('NGN')).toBe(1_700)
    expect(mod.getRate('GHS')).toBe(17.5)
    // KES was present but 0 — that code keeps its fallback rather than pricing
    // every balance at zero.
    expect(mod.getRate('KES')).toBe(129)
  })

  it('notifies subscribers so a priced balance replaces the stale one', async () => {
    const mod = loadCurrency()
    const listener = jest.fn()
    mod.subscribeToCurrency(listener)
    stubFetch(async () => jsonResponse({ rates: { NGN: 1_700 } }))

    await mod.refreshFxRates()

    // Without this the screen keeps the fallback figure until something else
    // happens to re-render it.
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

// ── Selected currency: the store ─────────────────────────────────────────────

describe('the currency store', () => {
  it('starts on the default currency', () => {
    expect(loadCurrency().getCurrency()).toBe('USD')
  })

  it('applies and persists a new selection', () => {
    const mod = loadCurrency()
    mod.setCurrency('NGN')
    expect(mod.getCurrency()).toBe('NGN')
    // Persisted, or every visit starts over in dollars.
    expect(localStorage.getItem('veil_currency')).toBe('NGN')
  })

  it('notifies subscribers once per change and stops after unsubscribe', () => {
    const mod = loadCurrency()
    const listener = jest.fn()
    const unsubscribe = mod.subscribeToCurrency(listener)

    mod.setCurrency('NGN')
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    mod.setCurrency('GHS')
    // A leaked listener keeps a dead component re-rendering.
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('treats re-selecting the current currency as a no-op', () => {
    const mod = loadCurrency()
    const listener = jest.fn()
    // Spying on the prototype: jsdom's Storage instances are proxies, so a spy
    // installed on the instance is never consulted by the module.
    const setItem = jest.spyOn(Storage.prototype, 'setItem')
    mod.subscribeToCurrency(listener)

    mod.setCurrency('NGN')
    mod.setCurrency('NGN')

    expect(listener).toHaveBeenCalledTimes(1)
    expect(setItem).toHaveBeenCalledTimes(1)
  })

  it('refuses a code that is not a currency', () => {
    const mod = loadCurrency()
    const setItem = jest.spyOn(Storage.prototype, 'setItem')

    mod.setCurrency('XYZ' as CurrencyCode)
    mod.setCurrency('toString' as CurrencyCode)

    // Storing either would make getRate return undefined and every balance NaN.
    expect(mod.getCurrency()).toBe('USD')
    expect(setItem).not.toHaveBeenCalled()
  })

  it('still applies the selection when storage refuses the write', () => {
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    const mod = loadCurrency()
    const listener = jest.fn()
    mod.subscribeToCurrency(listener)

    mod.setCurrency('KES')

    // A blocked write costs the preference next visit, not this click.
    expect(mod.getCurrency()).toBe('KES')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('applies the selection in memory, outside the browser too', () => {
    const mod = loadCurrency()
    mod.setCurrency('NGN')
    // No window check gates setCurrency: the value is applied even if the
    // persistence below it fails, so a caller never sees a half-applied change.
    expect(mod.getCurrency()).toBe('NGN')
  })
})

describe('hydrateCurrency', () => {
  it('applies a stored preference', () => {
    localStorage.setItem('veil_currency', 'GHS')
    const mod = loadCurrency()

    mod.hydrateCurrency()

    expect(mod.getCurrency()).toBe('GHS')
  })

  it('leaves the default when nothing has been stored', () => {
    const mod = loadCurrency()
    mod.hydrateCurrency()
    expect(mod.getCurrency()).toBe('USD')
  })

  it('leaves the default when the stored value is not a currency', () => {
    localStorage.setItem('veil_currency', 'toString')
    const mod = loadCurrency()

    mod.hydrateCurrency()

    expect(mod.getCurrency()).toBe('USD')
  })

  it('survives storage that throws on read (privacy mode)', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    const mod = loadCurrency()

    expect(() => mod.hydrateCurrency()).not.toThrow()
    expect(mod.getCurrency()).toBe('USD')
  })

  it('is idempotent — the preference is read once per session', () => {
    localStorage.setItem('veil_currency', 'GBP')
    const mod = loadCurrency()

    mod.hydrateCurrency()
    localStorage.setItem('veil_currency', 'ZAR')
    mod.hydrateCurrency()

    // Re-reading on every call would turn a stale write into a live change.
    expect(mod.getCurrency()).toBe('GBP')
  })

  it('notifies subscribers and starts the FX refresh', async () => {
    const mod = loadCurrency()
    const listener = jest.fn()
    mod.subscribeToCurrency(listener)
    const fetchMock = stubFetch(async () => jsonResponse({ rates: { NGN: 1_700 } }))

    mod.hydrateCurrency()

    expect(listener).toHaveBeenCalledTimes(1)
    // The refresh is fire-and-forget; the call is what matters here.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await mod.refreshFxRates()
  })

  it('starts the FX refresh once in the browser', () => {
    const mod = loadCurrency()
    const fetchMock = stubFetch(async () => jsonResponse({ rates: { NGN: 1_700 } }))

    // The no-window branch lives in currency.server.test.ts — jsdom's window is
    // non-configurable, so it cannot be removed here. This asserts the other
    // side of it: with a window, hydration is what upgrades the rate.
    mod.hydrateCurrency()
    mod.hydrateCurrency()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// ── useCurrency ──────────────────────────────────────────────────────────────

describe('useCurrency', () => {
  it('returns the selected currency and its rate', () => {
    const mod = loadCurrency()
    mod.setCurrency('NGN')

    expect(mod.useCurrency()).toEqual({ code: 'NGN', rate: 1600, live: false })
  })

  it('returns the live rate once a fetch has succeeded', async () => {
    const mod = loadCurrency()
    stubFetch(async () => jsonResponse({ rates: { NGN: 1_700 } }))
    await mod.refreshFxRates()

    expect(mod.useCurrency()).toEqual({ code: 'USD', rate: 1, live: true })
    mod.setCurrency('NGN')
    expect(mod.useCurrency()).toEqual({ code: 'NGN', rate: 1_700, live: true })
  })

  it('exposes a snapshot that changes when the currency changes', () => {
    const mod = loadCurrency()
    mod.useCurrency()
    const before = mockSyncStore.mock.calls.at(-1)![1]()

    mod.setCurrency('NGN')
    mod.useCurrency()
    const after = mockSyncStore.mock.calls.at(-1)![1]()

    // useSyncExternalStore only re-renders on an identity change; a snapshot
    // that stayed constant would leave the picker showing the old currency.
    expect(after).toBe(before + 1)
  })

  it('pins the server snapshot to a constant so hydration matches', () => {
    const mod = loadCurrency()
    mod.setCurrency('NGN')
    mod.useCurrency()
    const [, , getServerSnapshot] = mockSyncStore.mock.calls.at(-1)!

    // A server snapshot that varied would produce a hydration mismatch on every
    // visit with a non-default currency.
    expect(getServerSnapshot()).toBe(0)
  })
})
