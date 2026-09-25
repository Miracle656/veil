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
