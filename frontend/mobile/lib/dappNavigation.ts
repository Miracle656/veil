/**
 * Navigation rules for the in-app dApp browser.
 *
 * A grant belongs to one origin. The moment a link, a redirect or a popup
 * leaves that origin, the browser must not follow it in place — otherwise the
 * next page inherits the previous page's permissions, and the address bar
 * stops describing what is actually loaded.
 *
 * These rules are pure functions so they can be unit-tested without a WebView.
 * The shell in `app/dapp.tsx` only wires them to `onShouldStartLoadWithRequest`
 * and the injected popup blocker.
 *
 * The three outcomes are deliberately distinct:
 *
 * - `allow`    — the target is the origin already on screen; load it.
 * - `external` — a different HTTPS origin; offer the system browser instead.
 *                The grant never follows.
 * - `blocked`  — not HTTPS, or not a URL at all; never load it.
 */

import { normalizeOrigin } from './dappAllowlist';

/** What the browser should do with a top-level navigation request. */
export type NavigationDecision =
  | { action: 'allow' }
  | { action: 'external'; origin: string }
  | { action: 'blocked'; reason: 'insecure' | 'malformed' };

/** What the browser should do with a `window.open` request. */
export type PopupDecision =
  | { action: 'navigate' }
  | { action: 'external'; origin: string }
  | { action: 'block' };

/** The WebView's blank initial document — not a navigation, just a startup. */
const BLANK = 'about:blank';

/**
 * Decide what to do with a top-level navigation (link, redirect, form submit).
 *
 * Only the approved origin is allowed in place. Anything else that is a valid
 * HTTPS URL is handed to the system browser, and anything that is not is
 * refused. `about:blank` is allowed so the WebView can initialise.
 */
export function decideNavigation(approvedOrigin: string, targetUrl: string): NavigationDecision {
  if (typeof targetUrl !== 'string' || !targetUrl.trim()) {
    return { action: 'blocked', reason: 'malformed' };
  }
  if (targetUrl === BLANK || targetUrl.startsWith(`${BLANK}#`)) {
    return { action: 'allow' };
  }

  const origin = normalizeOrigin(targetUrl);
  if (origin === null) {
    return {
      action: 'blocked',
      reason: targetUrl.trim().toLowerCase().startsWith('http://') ? 'insecure' : 'malformed',
    };
  }

  // Same origin: this is the page the user approved, staying on itself.
  if (origin === approvedOrigin) return { action: 'allow' };

  // A different origin means leaving the approved page. The grant is dropped:
  // it is never re-attached to whatever is at the other end.
  return { action: 'external', origin };
}

/**
 * Decide what to do with a `window.open` from page JavaScript.
 *
 * A popup must never become a second in-app context that inherits the opener's
 * permissions. A same-origin popup is folded back into the current view
 * (`navigate`), a different HTTPS origin is offered to the system browser
 * (`external`), and everything else is dropped (`block`). In no case does the
 * page get a new window carrying its own grants.
 */
export function decidePopup(approvedOrigin: string, targetUrl: string): PopupDecision {
  if (typeof targetUrl !== 'string' || !targetUrl.trim() || targetUrl.startsWith('about:')) {
    return { action: 'block' };
  }

  const origin = normalizeOrigin(targetUrl);
  if (origin === null) return { action: 'block' };
  if (origin === approvedOrigin) return { action: 'navigate' };
  return { action: 'external', origin };
}

/**
 * The origin to show in the browser chrome.
 *
 * It is derived from the URL the WebView reports as loaded, but only when that
 * URL is still the approved origin. A blocked or handed-off redirect therefore
 * keeps the chrome describing what is actually on screen rather than flapping
 * to the destination that was refused.
 */
export function chromeOrigin(approvedOrigin: string, loadedUrl: string | null): string {
  if (loadedUrl) {
    const origin = normalizeOrigin(loadedUrl);
    if (origin === approvedOrigin) return origin;
  }
  return approvedOrigin;
}

/** The message the injected script posts back when a page calls `window.open`. */
export const WINDOW_OPEN_MESSAGE_TYPE = 'veil:window-open';

/**
 * Injected into every allow-listed page, before and after its own scripts run.
 *
 * `window.open` is replaced with a no-op that reports the URL to the app, so a
 * page can never create a window that would inherit the opener's permissions.
 * `window.opener` is pinned to `null` for the same reason, and `target="_blank"`
 * links are intercepted so they go through the same hand-off decision instead
 * of opening an uncontrolled context.
 *
 * This is a string because the WebView API takes one; {@link WINDOW_OPEN_MESSAGE_TYPE}
 * is what the handler matches on. The trailing `true;` is required by
 * `injectedJavaScript` to suppress a React Native warning.
 */
export const WINDOW_OPEN_BLOCKER_JS = `
(function () {
  try {
    Object.defineProperty(window, 'opener', { value: null, configurable: false });
  } catch (e) {}
  function report(url) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(
          JSON.stringify({ type: '${WINDOW_OPEN_MESSAGE_TYPE}', url: String(url || '') })
        );
      }
    } catch (e) {}
  }
  window.open = function (url) { report(url); return null; };
  document.addEventListener(
    'click',
    function (event) {
      var el = event.target;
      while (el && el.tagName !== 'A') { el = el.parentElement; }
      if (!el) return;
      var target = (el.getAttribute('target') || '').toLowerCase();
      if (target === '_blank') {
        event.preventDefault();
        report(el.href);
      }
    },
    true
  );
})();
true;
`;

/** A `window.open` request posted back by the injected blocker. */
export type WindowOpenMessage = { type: typeof WINDOW_OPEN_MESSAGE_TYPE; url: string };

/**
 * Parse a message from injected page JavaScript.
 *
 * Returns `null` for anything that is not a well-formed window-open report, so
 * an allow-listed page cannot smuggle an arbitrary payload into the handler.
 */
export function parseWindowOpenMessage(data: string): WindowOpenMessage | null {
  if (typeof data !== 'string') return null;
  try {
    const parsed = JSON.parse(data) as { type?: unknown; url?: unknown };
    if (parsed?.type !== WINDOW_OPEN_MESSAGE_TYPE) return null;
    if (typeof parsed.url !== 'string') return null;
    return { type: WINDOW_OPEN_MESSAGE_TYPE, url: parsed.url };
  } catch {
    return null;
  }
}
