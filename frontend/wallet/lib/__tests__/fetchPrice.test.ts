// @stellar/stellar-sdk needs TextEncoder at module load; jsdom omits it.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { fetchPrice, usdValue } from '../fetchPrice'
import { USDT0_MAINNET_ISSUER } from '../assets'

describe('wallet fetchPrice - USDT0 & dollar stablecoins (Issue #790)', () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
    jest.clearAllMocks()
  })

  it('treats verified USDT0 as a dollar stablecoin (price = 1.0) without network request', async () => {
    const spy = jest.fn()
    global.fetch = spy as unknown as typeof fetch
    await expect(fetchPrice('USDT0', USDT0_MAINNET_ISSUER)).resolves.toBe(1.0)
    await expect(fetchPrice('USDT0', undefined)).resolves.toBe(1.0)
    expect(spy).not.toHaveBeenCalled()
  })

  it('treats USDC as a dollar stablecoin (price = 1.0) without network request', async () => {
    const spy = jest.fn()
    global.fetch = spy as unknown as typeof fetch
    await expect(fetchPrice('USDC', null)).resolves.toBe(1.0)
    expect(spy).not.toHaveBeenCalled()
  })

  it('routes impostor USDT0 by code:issuer rather than treating it as 1.0', async () => {
    const FAKE_ISSUER = 'GC35JBERU4SFTDVOF32A2SIJN5FHSLSZFZSGP6VVFWCZNDVGJFLQBANK'
    const spy = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ price: 0.005 }),
    })
    global.fetch = spy as unknown as typeof fetch

    const price = await fetchPrice('USDT0', FAKE_ISSUER)
    expect(price).toBe(0.005)
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining(`/price/USDT0%3A${FAKE_ISSUER}/`),
      expect.any(Object),
    )
  })

  it('computes usdValue correct to 7 decimal places', () => {
    const balance = '123.4567891'
    const price = 1.0
    expect(usdValue(balance, price)).toBe(123.4567891)

    const fractionalPrice = 0.5
    expect(usdValue('10.0000002', fractionalPrice)).toBe(5.0000001)
  })
})

/**
 * What happens when the oracle is not there.
 *
 * Lens was suspended on 2026-10-05 and the web wallet showed no prices at all,
 * while mobile kept pricing balances — because mobile had an order-book fallback
 * and this module did not. Two copies of the same function, one of them better,
 * and the outage is what revealed which.
 */
describe('falls back to the SDEX order book when Lens is unavailable', () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
    jest.clearAllMocks()
  })

  const book = (bid: string, ask: string) => ({
    ok: true,
    json: async () => ({ bids: [{ price: bid }], asks: [{ price: ask }] }),
  })

  it('quotes the mid of the book when Lens returns a non-2xx', async () => {
    const spy = jest.fn(async (url: unknown) =>
      String(url).includes('/order_book')
        ? (book('0.2217832', '0.2219707') as never)
        : ({ ok: false, status: 503 } as never),
    )
    global.fetch = spy as unknown as typeof fetch

    await expect(fetchPrice('XLM', null)).resolves.toBeCloseTo(0.22187695, 8)
    expect(spy.mock.calls.some(([u]) => String(u).includes('/order_book'))).toBe(true)
  })

  it('falls back when Lens throws rather than answers', async () => {
    const spy = jest.fn(async (url: unknown) => {
      if (String(url).includes('/order_book')) return book('1.0', '1.1') as never
      throw new Error('ECONNREFUSED')
    })
    global.fetch = spy as unknown as typeof fetch

    await expect(fetchPrice('XLM', null)).resolves.toBeCloseTo(1.05, 6)
  })

  it('returns null rather than a one-sided price', async () => {
    // Taking whichever side exists would quote a price nobody will trade at.
    const spy = jest.fn(async (url: unknown) =>
      String(url).includes('/order_book')
        ? ({ ok: true, json: async () => ({ bids: [{ price: '0.22' }], asks: [] }) } as never)
        : ({ ok: false, status: 503 } as never),
    )
    global.fetch = spy as unknown as typeof fetch

    await expect(fetchPrice('XLM', null)).resolves.toBeNull()
  })

  it('still prefers Lens when it answers', async () => {
    const spy = jest.fn(async (url: unknown) =>
      String(url).includes('/order_book')
        ? (book('9', '9') as never)
        : ({ ok: true, json: async () => ({ price: 0.5 }) } as never),
    )
    global.fetch = spy as unknown as typeof fetch

    await expect(fetchPrice('XLM', null)).resolves.toBe(0.5)
    expect(spy.mock.calls.some(([u]) => String(u).includes('/order_book'))).toBe(false)
  })
})

