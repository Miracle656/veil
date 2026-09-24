'use client'

import { useEffect, useState } from 'react'
import { getBootnodeStatus, resolveBootnodeWithFallback, BootnodeStatus } from '../lib/privacy/bootnode'

export function BootnodeBanner() {
  const [status, setStatus] = useState<BootnodeStatus | null>(null)

  useEffect(() => {
    // Probe the primary bootnode URL.
    const primary = process.env.NEXT_PUBLIC_SPP_BOOTNODE_URL || null
    resolveBootnodeWithFallback(primary).then(() => {
      setStatus(getBootnodeStatus())
    })

    const interval = setInterval(() => {
      resolveBootnodeWithFallback(primary).then(() => {
        setStatus(getBootnodeStatus())
      })
    }, 5000)
    
    return () => clearInterval(interval)
  }, [])

  if (!status || !status.usingFallback || !status.reason) {
    return null
  }

  return (
    <div className="bg-yellow-500/10 border-b border-yellow-500/20 px-4 py-2 text-center text-sm text-yellow-600 dark:text-yellow-400">
      <span className="font-semibold">Warning:</span> {status.reason}
    </div>
  )
}
