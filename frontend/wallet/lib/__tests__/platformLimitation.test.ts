import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true })
Object.assign(globalThis, { TextEncoder, TextDecoder })

import {
  PLATFORM_NAME,
  OTHER_PLATFORM_NAME,
  WALLET_CREATION_LIMITATION_MESSAGE,
  FIRST_SPEND_LIMITATION_MESSAGE,
  WRONG_PLATFORM_ERROR_MESSAGE,
  isNativeOrigin,
  isWebOrigin,
  isWrongPlatformOrigin,
  fetchContractOrigin,
  isFirstSpend,
  markFirstSpendCompleted,
} from '../platformLimitation'
import * as walletDeployment from '../walletDeployment'

jest.mock('../walletDeployment', () => ({
  getDeploymentState: jest.fn(),
}))

describe('platformLimitation (web)', () => {
  beforeEach(() => {
    localStorage.clear()
    jest.clearAllMocks()
  })

  describe('copy & wording rules', () => {
    it('uses plain language without contract/protocol jargon', () => {
      const allCopy = [
        WALLET_CREATION_LIMITATION_MESSAGE,
        FIRST_SPEND_LIMITATION_MESSAGE,
        WRONG_PLATFORM_ERROR_MESSAGE,
      ].join(' ')

      // Must never use jargon in user-facing text
      expect(allCopy).not.toMatch(/__check_auth/)
      expect(allCopy).not.toMatch(/WebAuthn/i)
      expect(allCopy).not.toMatch(/origin/i)
      expect(allCopy).not.toMatch(/single-origin/i)
      expect(allCopy).not.toMatch(/rpId/i)
    })

    it('names the platform concretely', () => {
      expect(PLATFORM_NAME).toBe('this website')
      expect(OTHER_PLATFORM_NAME).toBe('the Veil mobile app')
      expect(WALLET_CREATION_LIMITATION_MESSAGE).toMatch(/this website only/i)
      expect(FIRST_SPEND_LIMITATION_MESSAGE).toMatch(/this website/i)
      expect(WRONG_PLATFORM_ERROR_MESSAGE).toMatch(/mobile app/i)
    })
  })

  describe('origin classification', () => {
    it('identifies native vs web origins', () => {
      expect(isNativeOrigin('android:apk-key-hash:D9qli1VVzfL7b5X0pddQcUG1tB6298g7VBbxvJkJV0Q')).toBe(true)
      expect(isNativeOrigin('ios:bundle-id:xyz.veil.app')).toBe(true)
      expect(isNativeOrigin('https://app.useveilapp.xyz')).toBe(false)
      expect(isNativeOrigin('http://localhost:3000')).toBe(false)

      expect(isWebOrigin('https://app.useveilapp.xyz')).toBe(true)
      expect(isWebOrigin('http://localhost:3000')).toBe(true)
      expect(isWebOrigin('android:apk-key-hash:D9qli1VVzfL7b5X0pddQcUG1tB6298g7VBbxvJkJV0Q')).toBe(false)
    })

    it('identifies native mobile origin as wrong platform on web', () => {
      expect(isWrongPlatformOrigin('android:apk-key-hash:D9qli1VVzfL7b5X0pddQcUG1tB6298g7VBbxvJkJV0Q')).toBe(true)
      expect(isWrongPlatformOrigin('ios:bundle-id:xyz.veil.app')).toBe(true)
      expect(isWrongPlatformOrigin('https://app.useveilapp.xyz')).toBe(false)
      expect(isWrongPlatformOrigin('http://localhost:3000')).toBe(false)
    })
  })

  describe('isFirstSpend & markFirstSpendCompleted', () => {
    const ADDRESS = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

    it('returns false for null address', async () => {
      expect(await isFirstSpend(null)).toBe(false)
    })

    it('returns false if already marked completed in storage', async () => {
      markFirstSpendCompleted(ADDRESS)
      expect(await isFirstSpend(ADDRESS)).toBe(false)
    })

    it('returns false if wallet is already deployed on-chain', async () => {
      ;(walletDeployment.getDeploymentState as jest.Mock).mockResolvedValueOnce('deployed')
      expect(await isFirstSpend(ADDRESS)).toBe(false)
      // And marks it completed so subsequent calls do not re-query
      expect(localStorage.getItem(`veil_first_spend_completed_${ADDRESS}`)).toBe('true')
    })

    it('returns true if wallet is undeployed and has not spent', async () => {
      ;(walletDeployment.getDeploymentState as jest.Mock).mockResolvedValueOnce('undeployed')
      expect(await isFirstSpend(ADDRESS)).toBe(true)
    })

    it('accepts knownState override when provided', async () => {
      expect(await isFirstSpend(ADDRESS, 'deployed')).toBe(false)
      expect(walletDeployment.getDeploymentState).not.toHaveBeenCalled()
    })
  })

  describe('fetchContractOrigin', () => {
    it('returns null for null or invalid contract address', async () => {
      expect(await fetchContractOrigin('http://localhost:8000', null)).toBeNull()
      expect(await fetchContractOrigin('http://localhost:8000', 'GA...')).toBeNull()
    })
  })
})
