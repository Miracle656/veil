'use client'

/**
 * Brings a user back to Veil Connect after they create or unlock a wallet.
 *
 * Both of those end on the dashboard. When this window was opened by another
 * app and its request is still waiting, the dashboard is the wrong place to
 * leave them, so they are sent back to /connect.
 *
 * Only ever acts on the dashboard, and only when a request is stored in this
 * window. A normal visit is untouched.
 */

import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'

import { readPending } from '@/lib/connectWindow'
import { walletSession } from '@/lib/walletStorage'

export function ConnectResume() {
  const pathname = usePathname()
  const router = useRouter()

  useEffect(() => {
    if (pathname !== '/dashboard') return
    const pending = readPending()
    if (!pending) return
    if (!walletSession.getItem('invisible_wallet_address')) return
    router.replace(`/connect?app=${encodeURIComponent(pending.appId)}`)
  }, [pathname, router])

  return null
}
