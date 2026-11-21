/// <reference types="jest" />

import type { NFTItem } from '../nfts'
import {
  UnconfirmedNameTransferError,
  assertTransferCanProceed,
  getNameTransferWarningCopy,
  shouldShowNameTransferWarning,
  validateNFTTransfer,
} from '../nftTransfer'
import { getTokenBoundName } from '../nfts'

const RECIPIENT_G = 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2UJAET74UYWXZGQST4BTY'

function makeToken(overrides: Partial<NFTItem> = {}): NFTItem {
  return {
    id: 'tok-1',
    contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANFT1',
    tokenId: '101',
    name: 'Test NFT #101',
    image: null,
    attributes: [],
    owner: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWLT',
    standard: 'CAP-46',
    ...overrides,
  }
}

describe('nftTransfer name transfer warnings (Issue #1077)', () => {
  describe('getTokenBoundName', () => {
    it('detects a name on explicit boundName property', () => {
      const token = makeToken({ boundName: 'alice*useveilapp.xyz' })
      expect(getTokenBoundName(token)).toBe('alice*useveilapp.xyz')
    })

    it('detects a name in token attributes with trait_type Name', () => {
      const token = makeToken({
        attributes: [
          { trait_type: 'Edition', value: '1 of 1' },
          { trait_type: 'Name', value: 'satoshi*useveilapp.xyz' },
        ],
      })
      expect(getTokenBoundName(token)).toBe('satoshi*useveilapp.xyz')
    })

    it('detects a name in token attributes with trait_type Federation Name', () => {
      const token = makeToken({
        attributes: [{ trait_type: 'Federation Name', value: 'bob*useveilapp.xyz' }],
      })
      expect(getTokenBoundName(token)).toBe('bob*useveilapp.xyz')
    })

    it('returns null for a token with no name attributes or property', () => {
      const token = makeToken({
        attributes: [{ trait_type: 'Tier', value: 'Gold' }],
      })
      expect(getTokenBoundName(token)).toBeNull()
    })
  })

  describe('shouldShowNameTransferWarning', () => {
    it('returns true when transferring a token that carries a name', () => {
      const tokenWithName = makeToken({ boundName: 'vitalik*useveilapp.xyz' })
      expect(shouldShowNameTransferWarning(tokenWithName)).toBe(true)
    })

    it('returns false when transferring a token with no name', () => {
      const regularToken = makeToken({ boundName: null, attributes: [] })
      expect(shouldShowNameTransferWarning(regularToken)).toBe(false)
    })
  })

  describe('getNameTransferWarningCopy', () => {
    it('names the specific name being moved in the title and consequence', () => {
      const copy = getNameTransferWarningCopy('alex*useveilapp.xyz')

      expect(copy.title).toBe('Transferring alex*useveilapp.xyz')
      expect(copy.consequence).toContain('The name "alex*useveilapp.xyz" goes with this token.')
      expect(copy.consequence).toContain('Anyone who has saved this name will pay the new holder from now on.')
      expect(copy.consequence).not.toContain('your name')
      expect(copy.acknowledgmentLabel).toContain('alex*useveilapp.xyz')
    })
  })

  describe('assertTransferCanProceed', () => {
    it('asserts the warning cannot be skipped on a name-carrying token', () => {
      const token = makeToken({ boundName: 'dxfareed*useveilapp.xyz' })

      // Trying to proceed without warning confirmation MUST throw
      expect(() => {
        assertTransferCanProceed(token, false)
      }).toThrow(UnconfirmedNameTransferError)

      expect(() => {
        assertTransferCanProceed(token, false)
      }).toThrow('Cannot transfer token carrying name "dxfareed*useveilapp.xyz" without explicit confirmation')
    })

    it('allows proceeding on a name-carrying token once confirmed', () => {
      const token = makeToken({ boundName: 'dxfareed*useveilapp.xyz' })

      expect(() => {
        assertTransferCanProceed(token, true)
      }).not.toThrow()
    })

    it('allows proceeding on a token with no name without requiring confirmation', () => {
      const tokenNoName = makeToken({ boundName: null })

      expect(() => {
        assertTransferCanProceed(tokenNoName, false)
      }).not.toThrow()
    })
  })

  describe('validateNFTTransfer', () => {
    it('fails when transferring a name-carrying token if confirmation is omitted', () => {
      const token = makeToken({ boundName: 'stellar*useveilapp.xyz' })
      const result = validateNFTTransfer(token, RECIPIENT_G, false)

      expect(result.valid).toBe(false)
      expect(result.requiresConfirmation).toBe(true)
      expect(result.boundName).toBe('stellar*useveilapp.xyz')
      expect(result.error).toContain('Transfer warning for name "stellar*useveilapp.xyz" must be confirmed')
    })

    it('succeeds when transferring a name-carrying token with confirmation', () => {
      const token = makeToken({ boundName: 'stellar*useveilapp.xyz' })
      const result = validateNFTTransfer(token, RECIPIENT_G, true)

      expect(result.valid).toBe(true)
      expect(result.requiresConfirmation).toBe(true)
      expect(result.boundName).toBe('stellar*useveilapp.xyz')
      expect(result.error).toBeUndefined()
    })

    it('succeeds when transferring a standard token with no name without requiring confirmation', () => {
      const token = makeToken({ boundName: null })
      const result = validateNFTTransfer(token, RECIPIENT_G, false)

      expect(result.valid).toBe(true)
      expect(result.requiresConfirmation).toBe(false)
      expect(result.boundName).toBeNull()
      expect(result.error).toBeUndefined()
    })

    it('validates recipient address', () => {
      const token = makeToken()
      const result = validateNFTTransfer(token, '', false)

      expect(result.valid).toBe(false)
      expect(result.error).toContain('Recipient address is required')
    })
  })
})
