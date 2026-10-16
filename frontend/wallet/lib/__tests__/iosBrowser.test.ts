/**
 * Naming the browser that can do PRF.
 *
 * A user on iOS 26 — years past Apple adding PRF for iCloud Keychain passkeys —
 * still got "PRF unavailable" in Chrome. Every iOS browser is WebKit underneath,
 * so the engine is not the difference; only Safari surfaces the extension. This
 * is what lets the downgrade notice say something actionable.
 */

import { isIOS, isNonSafariIOS } from '../iosBrowser'

const CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1'
const SAFARI_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const FIREFOX_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/133.0 Mobile/15E148 Safari/605.1.15'
const EDGE_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/131.0 Mobile/15E148 Safari/605.1.15'
const CHROME_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const IPAD_OS = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'

describe('isIOS', () => {
  it.each([CHROME_IOS, SAFARI_IOS, FIREFOX_IOS])('recognises an iPhone', (ua) => {
    expect(isIOS(ua, 5)).toBe(true)
  })

  // iPadOS 13+ claims to be a Mac; touch points are what tell them apart.
  it('recognises an iPad pretending to be a Mac', () => {
    expect(isIOS(IPAD_OS, 5)).toBe(true)
  })

  it('does not mistake a real Mac for one', () => {
    expect(isIOS(CHROME_DESKTOP, 0)).toBe(false)
    expect(isIOS(IPAD_OS, 0)).toBe(false)
  })
})

describe('isNonSafariIOS', () => {
  it.each([
    ['Chrome', CHROME_IOS],
    ['Firefox', FIREFOX_IOS],
    ['Edge', EDGE_IOS],
  ])('flags %s on iOS, which cannot offer PRF', (_name, ua) => {
    expect(isNonSafariIOS(ua, 5)).toBe(true)
  })

  // Safari's own UA contains "Safari" and none of the vendor tokens — and so,
  // confusingly, does every other iOS browser's. Hence testing for the tokens.
  it('does not flag Safari, which can', () => {
    expect(isNonSafariIOS(SAFARI_IOS, 5)).toBe(false)
  })

  it('does not flag desktop Chrome, where this advice would be wrong', () => {
    expect(isNonSafariIOS(CHROME_DESKTOP, 0)).toBe(false)
  })
})
