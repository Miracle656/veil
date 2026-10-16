if (typeof TextEncoder === 'undefined') {
  const { TextEncoder: TE, TextDecoder: TD } = require('util')
  global.TextEncoder = TE
  global.TextDecoder = TD
}

import {
  checkNameAvailability,
  executeClaim,
  getPendingClaim,
  setPendingClaim,
  clearPendingClaim,
  recoverPendingClaim,
  CLAIM_PRICE_DISPLAY,
} from '../claimClient'
import { walletLocal } from '../walletStorage'
import { globalNamesRegistry } from '../namesRegistry'

describe('claimClient (Issue #1079)', () => {
  beforeEach(() => {
    clearPendingClaim()
    if (typeof localStorage !== 'undefined') localStorage.clear()
    globalNamesRegistry.reset()
    jest.clearAllMocks()
  })

  test('reflects server normalisation and availability', async () => {
    // Mock global fetch for /api/names/available
    const mockFetch = jest.fn().mockImplementation((url: string) => {
      const parsedUrl = new URL(url, 'http://localhost')
      const name = parsedUrl.searchParams.get('name')
      if (name === 'veil') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            name,
            available: false,
            reason: 'Reserved name',
            price: CLAIM_PRICE_DISPLAY,
            priceUsdc: 5,
            nextClaimOrder: 1,
            hasFigure: true,
          }),
        })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          name,
          available: true,
          normalized: (name || '').toLowerCase(),
          price: CLAIM_PRICE_DISPLAY,
          priceUsdc: 5,
          nextClaimOrder: 1,
          hasFigure: true,
          figure: {
            id: 1,
            name: 'Veil Masquerade #01',
            crown: 'Plume',
            aperture: 'Twin slits',
          },
        }),
      })
    })
    global.fetch = mockFetch as any

    // Available name
    const avail = await checkNameAvailability('alice')
    expect(avail.available).toBe(true)
    expect(avail.price).toBe('5 USDC')
    expect(avail.hasFigure).toBe(true)
    expect(avail.figure?.id).toBe(1)

    // Reserved name
    const reserved = await checkNameAvailability('veil')
    expect(reserved.available).toBe(false)
    expect(reserved.reason).toBe('Reserved name')
  })

  test('tells claimant #21 that there is no figure before paying', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        name: 'latecomer',
        available: true,
        price: '5 USDC',
        priceUsdc: 5,
        nextClaimOrder: 21,
        hasFigure: false,
        figure: null,
        figureWarning: 'All 20 Veil Masquerade figures have been allocated. You will receive your name, but no Masquerade figure token.',
      }),
    })
    global.fetch = mockFetch as any

    const res = await checkNameAvailability('latecomer')
    expect(res.available).toBe(true)
    expect(res.hasFigure).toBe(false)
    expect(res.figure).toBeNull()
    expect(res.figureWarning).toContain('All 20 Veil Masquerade figures have been allocated')
  })

  test('pending claim recovery prevents double-charging when previous payment succeeded but API timed out', async () => {
    // 1. Setup pending claim from an interrupted previous attempt
    setPendingClaim({
      name: 'saturn',
      walletAddress: 'C123...',
      passkeyPublicKey: 'PK123...',
      paymentTxHash: '0xTX_PAID_ALREADY',
      timestamp: Date.now(),
    })

    const pending = getPendingClaim()
    expect(pending).not.toBeNull()
    expect(pending?.paymentTxHash).toBe('0xTX_PAID_ALREADY')

    // Mock API POST /api/names/claim returning success for recovery
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        record: {
          name: 'saturn',
          stellar_address: 'saturn*useveilapp.xyz',
          tokenId: '1',
          walletAddress: 'C123...',
          passkeyPublicKey: 'PK123...',
          hasFigure: true,
          figure: { id: 1, name: 'Veil Masquerade #01' },
        },
      }),
    })
    global.fetch = mockFetch as any

    // Execute claim with same name; should recover existing payment instead of charging again
    const result = await executeClaim({
      name: 'saturn',
      walletAddress: 'C123...',
      passkeyPublicKey: 'PK123...',
    })

    expect(result.success).toBe(true)
    expect(result.paymentTxHash).toBe('0xTX_PAID_ALREADY')
    expect(result.stellar_address).toBe('saturn*useveilapp.xyz')
    // After recovery, pending record is cleared
    expect(getPendingClaim()).toBeNull()
  })

  test('a failed payment leaves no half-claimed name', async () => {
    // When executeClaim fails before payment verification
    const mockFetch = jest.fn().mockImplementation((url: string, opts?: any) => {
      if (url.includes('/api/names/available')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ available: true, price: '5 USDC', nextClaimOrder: 1, hasFigure: true }),
        })
      }
      return Promise.resolve({
        ok: false,
        json: () => Promise.resolve({ error: 'Unpaid claim' }),
      })
    })
    global.fetch = mockFetch as any

    await expect(
      executeClaim({
        name: 'unpaidname',
        walletAddress: 'C123...',
        passkeyPublicKey: 'PK123...',
        mockPaymentTxHash: 'FAILED_HASH',
      })
    ).rejects.toThrow()

    // No claim registered in registry
    expect(globalNamesRegistry.getClaimByName('unpaidname')).toBeNull()
  })
})
