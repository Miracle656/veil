/**
 * Web half of dApp discovery parity (#813).
 *
 * `openDappInNewTab` is the only way the wallet opens a dApp: a new tab, on an
 * allow-listed HTTPS origin, with `noopener` — never an embedded frame. The
 * allow-list is the ONE module both apps read — mobile's
 * `lib/dappAllowlist.ts`, imported here as `@veil/dapps` — so its entries are
 * exercised directly: whatever the directory shows is exactly what opens.
 */

import { openDappInNewTab } from '../dapps'
import { DAPP_ALLOWLIST } from '@veil/dapps'

const originalOpen = window.open

afterEach(() => {
  window.open = originalOpen
})

describe('openDappInNewTab', () => {
  it('opens an allow-listed origin in a new tab with noopener', () => {
    const open = jest.fn().mockReturnValue({})
    window.open = open as unknown as typeof window.open

    const entry = DAPP_ALLOWLIST[0]!
    expect(openDappInNewTab(entry.origin)).toBe(true)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(entry.origin, '_blank', 'noopener,noreferrer')
  })

  it('opens exactly the listed origin for every directory entry', () => {
    // Whatever the directory renders is what opens — every entry, no
    // rewriting, no redirect tolerance.
    for (const entry of DAPP_ALLOWLIST) {
      const open = jest.fn().mockReturnValue({})
      window.open = open as unknown as typeof window.open

      expect(openDappInNewTab(entry.origin)).toBe(true)
      expect(open).toHaveBeenCalledWith(entry.origin, '_blank', 'noopener,noreferrer')
    }
  })

  it('opens the canonical origin for a URL with a path on a listed host', () => {
    const open = jest.fn().mockReturnValue({})
    window.open = open as unknown as typeof window.open

    const entry = DAPP_ALLOWLIST[0]!
    expect(openDappInNewTab(`${entry.origin}/some/deep/path?x=1`)).toBe(true)
    expect(open).toHaveBeenCalledWith(entry.origin, '_blank', 'noopener,noreferrer')
  })

  it('refuses a non-allow-listed origin without opening anything', () => {
    const open = jest.fn()
    window.open = open as unknown as typeof window.open

    expect(openDappInNewTab('https://evil.example')).toBe(false)
    expect(openDappInNewTab('https://soroswap.finance.evil.example')).toBe(false)
    expect(openDappInNewTab('https://app.soroswap.finance.evil.example')).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('refuses http:// even for an allow-listed host', () => {
    const open = jest.fn()
    window.open = open as unknown as typeof window.open

    const entry = DAPP_ALLOWLIST[0]!
    expect(openDappInNewTab(`http://${entry.origin.replace('https://', '')}`)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('refuses credentials smuggled into the authority', () => {
    const open = jest.fn()
    window.open = open as unknown as typeof window.open

    const entry = DAPP_ALLOWLIST[0]!
    expect(openDappInNewTab(`https://evil.example@${entry.origin.replace('https://', '')}`)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('refuses when window.open is unavailable (SSR, blocked pop-ups)', () => {
    window.open = undefined as unknown as typeof window.open
    const entry = DAPP_ALLOWLIST[0]!
    expect(openDappInNewTab(entry.origin)).toBe(false)
  })
})
