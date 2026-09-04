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

export default function RouteLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>
}
