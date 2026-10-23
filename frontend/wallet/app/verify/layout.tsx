/**
 * Wraps this route in the shared app shell (sidebar nav on desktop, top bar
 * below `lg`), exactly as every other wallet route does.
 */
import type { ReactNode } from 'react'

import { AppShell } from '@/components/AppShell'

export default function RouteLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>
}
