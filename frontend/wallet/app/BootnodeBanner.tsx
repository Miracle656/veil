'use client'

import { useEffect, useState } from 'react'
import { getBootnodeStatus, resolveBootnodeWithFallback, BootnodeStatus } from '../lib/privacy/bootnode'
import { getConfiguredBootnodeUrl } from '../lib/privacy/config'

export function BootnodeBanner() {
  const [status, setStatus] = useState<BootnodeStatus | null>(null)

  useEffect(() => {
    // Probe the primary bootnode URL.
    const primary = getConfiguredBootnodeUrl()
    resolveBootnodeWithFallback(primary).then(() => {
      setStatus(getBootnodeStatus())
    })

    const interval = setInterval(() => {
      resolveBootnodeWithFallback(primary).then(() => {
        setStatus(getBootnodeStatus())
      })
    }, 60_000)
    
    return () => clearInterval(interval)
  }, [])

  // Only a bootnode we configured and then lost is worth a banner.
  //
  // `unconfigured` is the project's current, documented state — Veil's own
  // bootnode (services/spp-bootnode, docs/SPP_BOOTNODE.md) is not deployed, so
  // Nethermind's public one is the intended source. Telling every visitor on
  // every page that an environment variable is unset is not information they
  // can act on, and a banner that is always there is one nobody reads. It stays
  // a console warning for whoever deploys this.
  if (!status || status.kind !== 'unreachable') {
    return null
  }

  return (
    <div className="bg-yellow-500/10 border-b border-yellow-500/20 px-4 py-2 text-center text-sm text-yellow-600 dark:text-yellow-400">
      <span className="font-semibold">Private payments:</span> our history server is
      unreachable, so syncing is going through Nethermind&apos;s public one. Balances and
      payments are unaffected.
    </div>
  )
}
