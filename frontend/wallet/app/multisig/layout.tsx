/**
 * Wraps this route in the shared app shell (sidebar nav on desktop, top bar
 * below `lg`).
 *
 * Done as a layout rather than by editing each page: every screen already
 * renders its own `.wallet-shell` > `.wallet-nav` > `.wallet-main` structure,
 * so wrapping here adds the shared chrome without touching a single line of
 * page or signing logic. `globals.css` hides the now-duplicated per-page
 * `.wallet-nav` when it sits inside the shell.
 */
import type { ReactNode } from 'react'

import { AppShell } from '@/components/AppShell'

import { MultisigGate } from './MultisigGate'

/**
 * The gate sits inside the shell and outside the page, so a user on a network
 * without the multisig contract keeps the normal chrome while the route itself
 * never renders — see MultisigGate for why this is a guard and not just a
 * hidden nav entry (#672).
 */
export default function RouteLayout({ children }: { children: ReactNode }) {
  return (
    <AppShell>
      <MultisigGate>{children}</MultisigGate>
    </AppShell>
  )
}
