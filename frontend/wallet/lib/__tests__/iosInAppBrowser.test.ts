/**
 * In-app browser detection, and what a failed passkey registration says.
 *
 * Written from a live report: somebody on iOS tapped Create wallet and got
 * WebAuthn's own `NotAllowedError` text — "not allowed by the user agent or
 * the platform in the current context, possibly because the user denied
 * permission" — which blames them for something they did not do and offers no
 * way out. They were in an app's embedded browser, where a passkey cannot be
 * created at all.
 */
import {
  isIOSInAppBrowser,
  isNonSafariIOS,
  passkeyFailureMessage,
} from '../iosBrowser'

const SAFARI_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
// A WKWebView hosted by another app: same engine, no `Version/` token. This is
// what Telegram's in-app browser sends, and Telegram is where most people
// arrive from.
const TELEGRAM_WEBVIEW =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
const FACEBOOK_WEBVIEW =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0]'
const CHROME_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1'
const DESKTOP_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

const notAllowed = () => {
  const e = new Error(
    'The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission.',
  )
  e.name = 'NotAllowedError'
  return e
}

describe('isIOSInAppBrowser', () => {
  it('catches a webview with no vendor marker, by the missing Version token', () => {
    // The case that actually bit a user. Mobile Safari always sends
    // `Version/<n>`; an embedded WKWebView does not.
    expect(isIOSInAppBrowser(TELEGRAM_WEBVIEW, 5)).toBe(true)
  })

  it('catches a webview that does mark itself', () => {
    expect(isIOSInAppBrowser(FACEBOOK_WEBVIEW, 5)).toBe(true)
  })

  it('does not accuse real Safari', () => {
    expect(isIOSInAppBrowser(SAFARI_IOS, 5)).toBe(false)
  })

  it('does not accuse a real third-party iOS browser', () => {
    // Chrome on iOS is a different problem with a different answer, and
    // isNonSafariIOS already covers it.
    expect(isIOSInAppBrowser(CHROME_IOS, 5)).toBe(false)
    expect(isNonSafariIOS(CHROME_IOS, 5)).toBe(true)
  })

  it('says nothing about anything that is not iOS', () => {
    expect(isIOSInAppBrowser(DESKTOP_CHROME, 0)).toBe(false)
  })
})

describe('passkeyFailureMessage', () => {
  it('tells an in-app browser user how to get out of it', () => {
    const msg = passkeyFailureMessage(notAllowed(), TELEGRAM_WEBVIEW, 5)
    expect(msg).toMatch(/another app/i)
    expect(msg).toMatch(/Open in Safari/)
    // The point is that it must not repeat WebAuthn's accusation.
    expect(msg).not.toMatch(/denied permission/i)
  })

  it('points an iOS Chrome user at Safari', () => {
    expect(passkeyFailureMessage(notAllowed(), CHROME_IOS, 5)).toMatch(/needs Safari/)
  })

  it('assumes a dismissed prompt everywhere else, and says to retry', () => {
    const msg = passkeyFailureMessage(notAllowed(), DESKTOP_CHROME, 0)
    expect(msg).toMatch(/dismissed or blocked/i)
    expect(msg).toMatch(/Try again/)
  })

  it('recognises the condition by message when the error name is missing', () => {
    // Some wrappers re-throw a plain Error and lose `name`.
    const bare = new Error(
      'The request is not allowed by the user agent or the platform in the current context.',
    )
    expect(passkeyFailureMessage(bare, TELEGRAM_WEBVIEW, 5)).toMatch(/Open in Safari/)
  })

  it('declines to improve an error it does not understand', () => {
    // Returning null makes the caller show the real error rather than a
    // confident guess that sends someone to Safari over a network failure.
    expect(passkeyFailureMessage(new Error('Network request failed'), SAFARI_IOS, 5)).toBeNull()
    expect(passkeyFailureMessage(null, SAFARI_IOS, 5)).toBeNull()
  })
})
