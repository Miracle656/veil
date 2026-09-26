/**
 * Web half of dApp discovery parity (#813).
 *
 * `openDappInNewTab` is the only way the wallet opens a dApp: a new tab, on an
 * allow-listed HTTPS origin, with `noopener` — never an embedded frame. The
 * allow-list itself lives in `frontend/shared/dapps.ts` and is rendered by
 * both apps, so its invariants are asserted here too.
 */

import { openDappInNewTab } from '../dapps'
import {
  DAPP_DIRECTORY,
  isAllowedDappOrigin,
  normalizeDappOrigin,
} from '../../../shared/dapps'

const originalOpen = window.open

afterEach(() => {
  window.open = originalOpen
})

describe('openDappInNewTab', () => {
  it('opens an allow-listed origin in a new tab with noopener', () => {
    const open = jest.fn().mockReturnValue({})
    window.open = open as unknown as typeof window.open

    const entry = DAPP_DIRECTORY[0]
    expect(openDappInNewTab(entry.origin)).toBe(true)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(entry.origin, '_blank', 'noopener,noreferrer')
  })

  it('refuses a non-allow-listed origin without opening anything', () => {
    const open = jest.fn()
    window.open = open as unknown as typeof window.open

    expect(openDappInNewTab('https://evil.example')).toBe(false)
    expect(openDappInNewTab('https://stellarx.com.evil.example')).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('refuses http:// even for an allow-listed host', () => {
    const open = jest.fn()
    window.open = open as unknown as typeof window.open

    expect(openDappInNewTab('http://stellarx.com')).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('returns false without throwing when the browser blocks the popup', () => {
    window.open = jest.fn().mockReturnValue(null) as unknown as typeof window.open

    expect(openDappInNewTab(DAPP_DIRECTORY[0].origin)).toBe(false)
  })
})

describe('DAPP_DIRECTORY', () => {
  it('is non-empty with unique ids and complete entries', () => {
    expect(DAPP_DIRECTORY.length).toBeGreaterThan(0)

    const ids = DAPP_DIRECTORY.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)

    for (const entry of DAPP_DIRECTORY) {
      expect(entry.name.trim()).not.toBe('')
      expect(entry.description.trim()).not.toBe('')
    }
  })

  it('holds only canonical https origins that the allow-list accepts', () => {
    for (const entry of DAPP_DIRECTORY) {
      // The stored origin is already canonical: https, no path, no www.
      expect(normalizeDappOrigin(entry.origin)).toBe(entry.origin)
      expect(isAllowedDappOrigin(entry.origin)).toBe(true)
    }
  })

  it('treats the www form of a listed host as the same origin', () => {
    for (const entry of DAPP_DIRECTORY) {
      const host = entry.origin.slice('https://'.length)
      expect(isAllowedDappOrigin(`https://www.${host}/deep/link?x=1`)).toBe(true)
    }
  })

  it('refuses http, javascript, unknown and look-alike origins', () => {
    expect(isAllowedDappOrigin('http://stellarx.com')).toBe(false)
    expect(isAllowedDappOrigin('javascript:alert(1)')).toBe(false)
    expect(isAllowedDappOrigin('https://evil.example')).toBe(false)
    expect(isAllowedDappOrigin('https://stellarx.com.evil.example')).toBe(false)
    expect(isAllowedDappOrigin('not a url')).toBe(false)
  })
})
