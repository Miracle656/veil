/**
 * Opening a dApp from the web wallet.
 *
 * Parity with mobile's dApp directory and origin-scoped browser (#897, #813)
 * means discovery, not embedding: the desktop wallet must never host a browser
 * inside itself — a browser inside a browser adds a signing surface with none
 * of the isolation. So every open is a NEW TAB on an allow-listed HTTPS
 * origin, checked against the ONE allow-list module both apps share —
 * `frontend/mobile/lib/dappAllowlist.ts`, imported here as `@veil/dapps`.
 *
 * The tab itself carries no wallet material: nothing is injected, and the user
 * connects back through the existing WalletConnect approval flow.
 */

import { allowedOriginOf } from '@veil/dapps'

/**
 * Open an allow-listed dApp in a new browser tab.
 *
 * Returns `true` only when a tab was actually opened. Refuses (without opening
 * anything) any URL that is not an allow-listed HTTPS origin — the allow-list
 * check runs even though the caller only ever passes entries from the shared
 * directory, so a future caller cannot turn this into a generic opener.
 *
 * The origin comparison is exact: scheme + host + port, no `www.` stripping
 * and no suffix tolerance. A directory may choose to display a friendlier
 * hostname, but what is checked — and what opens — is the listed origin and
 * nothing else, the same rule the browser shell and the per-origin grants
 * apply.
 */
export function openDappInNewTab(url: string): boolean {
  if (typeof window === 'undefined' || typeof window.open !== 'function') return false

  const origin = allowedOriginOf(url)
  if (!origin) return false

  // `noopener` severs `window.opener` (the opened page gets no handle back
  // into the wallet), `_blank` guarantees a tab rather than replacing the
  // wallet itself.
  const opened = window.open(origin, '_blank', 'noopener,noreferrer')
  return opened !== null
}
