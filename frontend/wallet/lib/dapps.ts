/**
 * Opening a dApp from the web wallet.
 *
 * Parity with mobile's dApp shell means discovery, not embedding: the desktop
 * wallet must never host a browser inside itself — a browser inside a browser
 * adds a signing surface with none of the isolation. So every open is a NEW
 * TAB on an allow-listed HTTPS origin, checked against the same shared module
 * the directory screen renders (`frontend/shared/dapps.ts`).
 *
 * The tab itself carries no wallet material: nothing is injected, and the user
 * connects back through the existing WalletConnect approval flow.
 */

import { isAllowedDappOrigin, normalizeDappOrigin } from '../../shared/dapps';

/**
 * Open an allow-listed dApp in a new browser tab.
 *
 * Returns `true` only when a tab was actually opened. Refuses (without opening
 * anything) any URL that is not an allow-listed HTTPS origin — the allow-list
 * check runs even though the caller only ever passes entries from the shared
 * directory, so a future caller cannot turn this into a generic opener.
 */
export function openDappInNewTab(url: string): boolean {
  if (typeof window === 'undefined' || typeof window.open !== 'function') return false;

  const origin = normalizeDappOrigin(url);
  if (!origin || !isAllowedDappOrigin(origin)) return false;

  // `noopener` severs `window.opener` (the opened page gets no handle back
  // into the wallet), `_blank` guarantees a tab rather than replacing the
  // wallet itself.
  const opened = window.open(origin, '_blank', 'noopener,noreferrer');
  return opened !== null;
}
