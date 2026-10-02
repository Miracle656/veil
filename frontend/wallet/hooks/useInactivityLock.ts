import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { txActive } from '@/lib/txState'
import { createIdleWatcher } from '@/lib/idle-lock'

/**
 * Locks the wallet after a configurable period of inactivity.
 *
 * Behaviour and the timeout itself live in `lib/idle-lock.ts`; this hook just
 * wires the watcher to Next's router and the session store. On lock it clears
 * in-memory session state and routes to `/lock`, which re-prompts the passkey.
 * The timeout (5 / 15 / 30 minutes, or never) is configured in
 * Settings → Security and applied immediately.
 */
export function useInactivityLock() {
  const router = useRouter()

  useEffect(() => {
    const watcher = createIdleWatcher({
      onLock: () => {
        sessionStorage.clear()
        router.replace('/lock')
      },
      // Never lock mid-transaction.
      shouldDefer: txActive,
    })
    watcher.start()
    return () => watcher.stop()
  }, [router])
}
