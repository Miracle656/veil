/**
 * Tests for cable TV and betting lookup functions.
 *
 * These tests verify the lookup API functions work correctly
 * against mocked providers.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'

// We need to mock the internal call function. Since it's not exported,
// we'll test the exported functions with a proper mock setup.
describe('Cable TV and betting lookup', () => {
  it('should have lookupCableTv function defined', () => {
    const { lookupCableTv } = require('../onramp')
    expect(typeof lookupCableTv).toBe('function')
  })

  it('should have lookupBetting function defined', () => {
    const { lookupBetting } = require('../onramp')
    expect(typeof lookupBetting).toBe('function')
  })

  it('should have isBillCategoryAvailable function defined', () => {
    const { isBillCategoryAvailable } = require('../onramp')
    expect(typeof isBillCategoryAvailable).toBe('function')
  })
})

describe('Cable TV lookup', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should return customer details on successful lookup', async () => {
    const mockResponse = {
      customerName: 'John Doe',
      currentPackage: 'DSTV Compact',
      dueDate: '2026-11-15',
      availablePackages: [
        { id: 'pkg1', name: 'DSTV Compact', price: 10500 },
        { id: 'pkg2', name: 'DSTV Compact Plus', price: 16500 },
      ],
    }

    call.mockResolvedValue(mockResponse)

    const result = await lookupCableTv({
      provider: 'DSTV',
      smartcardNumber: '1234567890',
    })

    expect(call).toHaveBeenCalledWith('/ngn/bills/lookup/cabletv', {
      method: 'POST',
      body: { provider: 'DSTV', smartcardNumber: '1234567890' },
    })
    expect(result).toEqual(mockResponse)
  })

  it('should handle lookup failure gracefully', async () => {
    call.mockRejectedValue(new Error('Smartcard not found'))

    await expect(
      lookupCableTv({
        provider: 'DSTV',
        smartcardNumber: 'invalid',
      }),
    ).rejects.toThrow('Smartcard not found')
  })
})

describe('Betting lookup', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should return account details on successful lookup', async () => {
    const mockResponse = {
      accountName: 'John Doe',
      accountStatus: 'active',
      balance: 5000,
    }

    call.mockResolvedValue(mockResponse)

    const result = await lookupBetting({
      provider: 'Bet9ja',
      accountId: 'user123',
    })

    expect(call).toHaveBeenCalledWith('/ngn/bills/lookup/betting', {
      method: 'POST',
      body: { provider: 'Bet9ja', accountId: 'user123' },
    })
    expect(result).toEqual(mockResponse)
  })

  it('should handle lookup failure gracefully', async () => {
    call.mockRejectedValue(new Error('Account not found'))

    await expect(
      lookupBetting({
        provider: 'Bet9ja',
        accountId: 'invalid',
      }),
    ).rejects.toThrow('Account not found')
  })
})

describe('Bill category availability', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should return true when naira rails are available', async () => {
    call.mockResolvedValue({ rate: 1500 })

    const result = await isBillCategoryAvailable('cabletv')

    expect(result).toBe(true)
  })

  it('should return false when naira rails are unavailable', async () => {
    call.mockRejectedValue(new Error('Service unavailable'))

    const result = await isBillCategoryAvailable('betting')

    expect(result).toBe(false)
  })
})
