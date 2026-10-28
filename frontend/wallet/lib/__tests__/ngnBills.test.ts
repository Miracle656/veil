/**
 * Tests for cable TV and betting lookup functions in wallet.
 *
 * These tests verify the lookup API functions are properly exported
 * and have the correct signatures.
 */

import { describe, it, expect } from '@jest/globals'
import {
  lookupCableTv,
  lookupBetting,
  isBillCategoryAvailable,
  type CableTvLookup,
  type BettingLookup,
} from '../ngn'

describe('Cable TV and betting lookup - wallet', () => {
  it('should have lookupCableTv function defined', () => {
    expect(typeof lookupCableTv).toBe('function')
  })

  it('should have lookupBetting function defined', () => {
    expect(typeof lookupBetting).toBe('function')
  })

  it('should have isBillCategoryAvailable function defined', () => {
    expect(typeof isBillCategoryAvailable).toBe('function')
  })

  it('should accept correct parameters for lookupCableTv', () => {
    // This is a compile-time check - if the types are wrong, TypeScript will fail
    const params = {
      provider: 'DSTV',
      smartcardNumber: '1234567890',
    }
    // Just verify the function can be called with the right type
    expect(() => lookupCableTv(params)).not.toThrow()
  })

  it('should accept correct parameters for lookupBetting', () => {
    const params = {
      provider: 'Bet9ja',
      accountId: 'user123',
    }
    expect(() => lookupBetting(params)).not.toThrow()
  })

  it('should accept correct parameters for isBillCategoryAvailable', () => {
    expect(() => isBillCategoryAvailable('cabletv')).not.toThrow()
    expect(() => isBillCategoryAvailable('betting')).not.toThrow()
    expect(() => isBillCategoryAvailable('airtime')).not.toThrow()
  })
})
