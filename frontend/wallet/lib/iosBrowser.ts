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
