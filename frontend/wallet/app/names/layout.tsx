/**
 * Wraps /names in the shared app shell, like every other route.
 *
 * The design gives this page its own marketing-style top nav (Wallet / Names /
 * Earn / Docs). That is dropped on purpose: claiming a name needs a wallet, a
 * passkey and a balance, so the page lives inside the signed-in app, and a
 * second navigation scheme in one app is worse than a faithful port.
 */
import type { ReactNode } from 'react'

import { AppShell } from '@/components/AppShell'

export default function RouteLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>
}
