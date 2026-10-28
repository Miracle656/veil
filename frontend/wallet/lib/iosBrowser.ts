/**
 * Whether this is an iOS browser that is not Safari.
 *
 * Only one thing turns on this: WebAuthn PRF. Apple has supported it for
 * iCloud Keychain passkeys since iOS 18, but only through Safari — a user on
 * iOS 26, far past that, still got "PRF unavailable" in Chrome. Every browser
 * on iOS is WebKit underneath, so the engine is not the difference; the
 * WebAuthn integration is, and the other browsers do not surface the extension.
 *
 * That makes the fee-payer downgrade notice answerable instead of merely true.
 * Without this it says "this browser can't", which is correct and useless; with
 * it the page can name the browser that can.
 *
 * Deliberately narrow. The user agent is a poor thing to branch on and this
 * does not use it to decide anything functional — PRF is still attempted and
 * its real outcome is what drives the banner. This only chooses a sentence.
 */

/** iOS or iPadOS, including an iPad reporting itself as a Mac with touch. */
export function isIOS(userAgent: string = navigator.userAgent, maxTouchPoints = navigator.maxTouchPoints): boolean {
  if (/iPad|iPhone|iPod/.test(userAgent)) return true
  // iPadOS 13+ claims to be a Mac. A real Mac has no touch points.
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1
}

/**
 * An iOS browser that is not Safari, and therefore cannot offer PRF.
 *
 * Each of these tokens is the vendor's own iOS marker — Chrome is `CriOS`,
 * Firefox `FxiOS`, Edge `EdgiOS`, Opera `OPiOS`. Safari alone carries none of
 * them, so the test is for a known alternative rather than for Safari itself:
 * a browser we have never heard of should not be told it is the problem.
 */
export function isNonSafariIOS(
  userAgent: string = navigator.userAgent,
  maxTouchPoints = navigator.maxTouchPoints,
): boolean {
  return isIOS(userAgent, maxTouchPoints) && /CriOS|FxiOS|EdgiOS|OPiOS|GSA/.test(userAgent)
}

/**
 * Whether this looks like an app's embedded browser rather than a real one.
 *
 * On iOS a passkey cannot be created inside most in-app webviews: the host app
 * has to opt into the platform authenticator, and almost none do. The attempt
 * fails with WebAuthn's `NotAllowedError`, whose own wording — "not allowed by
 * the user agent or the platform in the current context, possibly because the
 * user denied permission" — blames the user for something they did not do and
 * names no way out.
 *
 * Two signals, neither trusted alone:
 *
 * 1. A vendor's own marker, where there is one. These are reliable but only
 *    cover the apps that bother to set one.
 * 2. The absence of `Version/<n>`. Mobile Safari always sends it; a WKWebView
 *    hosted by another app does not. This catches the ones with no marker —
 *    Telegram among them, which matters because that is where most people
 *    arrive from.
 *
 * Like `isNonSafariIOS`, this decides a sentence and never a capability.
 * Registration is still attempted and its real outcome is what the page
 * reports; a false positive costs a slightly wrong hint, never a blocked
 * signup.
 */
export function isIOSInAppBrowser(
  userAgent: string = navigator.userAgent,
  maxTouchPoints = navigator.maxTouchPoints,
): boolean {
  if (!isIOS(userAgent, maxTouchPoints)) return false
  // A real third-party browser is a different problem with a different answer.
  if (isNonSafariIOS(userAgent, maxTouchPoints)) return false
  if (/FBAN|FBAV|Instagram|LinkedInApp|Line\/|MicroMessenger|Snapchat|Twitter|musical_ly|TikTok|WhatsApp|Telegram/i.test(userAgent)) {
    return true
  }
  return !/Version\/\d/.test(userAgent)
}

/**
 * What to tell somebody whose passkey registration failed.
 *
 * `NotAllowedError` is raised both when the platform refuses outright and when
 * the person dismisses the Face ID sheet, and the browser gives no way to tell
 * those apart. So the environment decides the wording: inside an app's browser
 * the overwhelmingly likely cause is the webview, and the answer is to open the
 * page properly. Anywhere else, assume they cancelled and let them retry.
 *
 * Returns null when the error is not one this can improve on, so the caller
 * shows the original rather than guessing.
 */
export function passkeyFailureMessage(
  error: unknown,
  userAgent: string = navigator.userAgent,
  maxTouchPoints = navigator.maxTouchPoints,
): string | null {
  const name = (error as { name?: string } | null)?.name
  const message = error instanceof Error ? error.message : String(error ?? '')
  const notAllowed = name === 'NotAllowedError' || /not allowed by the user agent/i.test(message)
  if (!notAllowed) return null

  if (isIOSInAppBrowser(userAgent, maxTouchPoints)) {
    return 'This page is open inside another app’s browser, which cannot create a passkey. Tap the … menu and choose Open in Safari, then try again.'
  }
  if (isNonSafariIOS(userAgent, maxTouchPoints)) {
    return 'Creating a passkey on iOS needs Safari. Open app.useveilapp.xyz in Safari and try again.'
  }
  return 'The passkey prompt was dismissed or blocked. Try again, and approve the prompt when your device asks.'
}
