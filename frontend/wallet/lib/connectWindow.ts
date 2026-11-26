/**
 * The browser half of Veil Connect: what the Veil window stores while the
 * user signs in or pays, and how it answers the app that opened it.
 *
 * Kept apart from lib/connect.ts so the rules there stay free of `window`.
 */
import {
  decodePending,
  encodePending,
  PENDING_KEY,
  resultMessage,
  type ConnectResult,
  type PendingConnect,
} from './connect'

/**
 * The demo app answers only to pages on localhost. It is on in development,
 * and in a build only when NEXT_PUBLIC_VEIL_CONNECT_DEMO is "1" (for trying a
 * production build on your own machine). Leave it unset on the live site.
 */
export const ALLOW_DEMO_APP =
  process.env.NODE_ENV !== 'production' || process.env.NEXT_PUBLIC_VEIL_CONNECT_DEMO === '1'

// Plain sessionStorage on purpose, not the per-network wallet storage: the
// request belongs to this window, whatever network the wallet is on.

export function readPending(): PendingConnect | null {
  if (typeof window === 'undefined') return null
  try {
    return decodePending(window.sessionStorage.getItem(PENDING_KEY), ALLOW_DEMO_APP)
  } catch {
    return null
  }
}

export function writePending(pending: PendingConnect): void {
  try { window.sessionStorage.setItem(PENDING_KEY, encodePending(pending)) } catch { /* private window */ }
}

export function clearPending(): void {
  try { window.sessionStorage.removeItem(PENDING_KEY) } catch { /* private window */ }
}

/**
 * Send the answer to the app that asked, and to that origin only. Returns
 * false when the window that opened us is gone, so the caller can say so.
 */
export function answer(pending: PendingConnect, result: ConnectResult): boolean {
  const opener = typeof window === 'undefined' ? null : (window.opener as Window | null)
  if (!opener || opener.closed) return false
  try {
    opener.postMessage(resultMessage(pending.request.id, result), pending.origin)
    return true
  } catch {
    return false
  }
}
