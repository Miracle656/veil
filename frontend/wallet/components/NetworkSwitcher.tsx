'use client'

/**
 * Testnet/mainnet switch.
 *
 * The deployed wallet used to be pinned to whatever `NEXT_PUBLIC_NETWORK` was
 * set at build time, so the live site could only ever talk to one chain. This
 * lets a visitor move between them without a redeploy.
 *
 * Mainnet is offered only when this deployment can actually reach a mainnet
 * Soroban RPC. Rendering an enabled control that fails on first use would be
 * worse than rendering a disabled one that says why.
 */
import { useEffect, useState } from 'react'

import {
  getNetworkName,
  mainnetUsesProxy,
  setActiveNetwork,
  type VeilNetworkName,
} from '@/lib/network'

const OPTIONS: { name: VeilNetworkName; label: string; dot: string }[] = [
  { name: 'testnet', label: 'Testnet', dot: 'var(--teal)' },
  { name: 'mainnet', label: 'Mainnet', dot: 'var(--gold)' },
]

export function NetworkSwitcher({ className = '' }: { className?: string }) {
  // The active network comes from localStorage, which the server cannot see.
  // Rendering it before mount would produce different server and client HTML.
  const [mounted, setMounted] = useState(false)
  const [mainnetReady, setMainnetReady] = useState(!mainnetUsesProxy())
  const [switching, setSwitching] = useState<VeilNetworkName | null>(null)

  useEffect(() => {
    setMounted(true)
    if (!mainnetUsesProxy()) return

    let cancelled = false
    fetch('/api/rpc/mainnet', { method: 'GET' })
      .then((res) => (res.ok ? res.json() : { configured: false }))
      .then((body: { configured?: boolean }) => {
        if (!cancelled) setMainnetReady(Boolean(body?.configured))
      })
      .catch(() => {
        if (!cancelled) setMainnetReady(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!mounted) {
    // Reserve the same height so the sidebar does not jump on hydration.
    return <div className={`h-[30px] ${className}`} aria-hidden="true" />
  }

  const active = getNetworkName()

  return (
    <div className={className}>
      <div
        role="radiogroup"
        aria-label="Stellar network"
        className="flex gap-1 bg-[rgba(255,255,255,0.04)] border border-border-dim rounded-pill p-[3px]"
      >
        {OPTIONS.map((option) => {
          const isActive = option.name === active
          const disabled = option.name === 'mainnet' && !mainnetReady
          return (
            <button
              key={option.name}
              type="button"
              role="radio"
              aria-checked={isActive}
              disabled={disabled || switching !== null}
              title={
                disabled
                  ? 'This deployment has no mainnet Soroban RPC configured (MAINNET_RPC_URL).'
                  : undefined
              }
              onClick={() => {
                if (isActive) return
                setSwitching(option.name)
                // Reloads the page on success; nothing after this runs.
                if (!setActiveNetwork(option.name)) setSwitching(null)
              }}
              className="flex-1 flex items-center justify-center gap-[6px] rounded-pill px-[10px] py-[5px] text-[11px] font-mono transition-colors duration-150 disabled:cursor-not-allowed"
              style={{
                background: isActive ? 'var(--surface-md)' : 'transparent',
                border: `1px solid ${isActive ? 'var(--gold)' : 'transparent'}`,
                color: isActive ? 'var(--gold)' : 'rgba(246,247,248,0.5)',
                opacity: disabled ? 0.4 : 1,
              }}
            >
              <span
                className="w-[6px] h-[6px] rounded-full shrink-0"
                style={{ background: isActive ? option.dot : 'rgba(246,247,248,0.3)' }}
              />
              {switching === option.name ? 'Switching…' : option.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
