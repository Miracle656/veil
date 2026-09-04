'use client'

/**
 * Display-currency selector for the sidebar.
 *
 * Veil is fiat-facing — the point of the product is that a Nigerian user reads
 * their balance in naira, not in XLM — so this sits next to the network switch
 * rather than being buried in settings.
 *
 * Changing it does not reload: unlike the network, the currency affects only
 * how numbers are rendered, never which chain is queried or which keys are
 * derived, so the external store re-renders subscribers in place.
 */
import { useEffect, useState } from 'react'

import { CURRENCIES, CURRENCY_CODES, hydrateCurrency, setCurrency, useCurrency } from '@/lib/currency'

export function CurrencyPicker({ className = '' }: { className?: string }) {
  const { code, live } = useCurrency()
  // The stored preference is client-only, so the first paint must match the
  // server's default before switching to it.
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    hydrateCurrency()
    setMounted(true)
  }, [])

  if (!mounted) return <div className={`h-[26px] ${className}`} aria-hidden="true" />

  return (
    <label className={`flex items-center gap-2 ${className}`}>
      <span className="sr-only">Display currency</span>
      <select
        value={code}
        onChange={(e) => setCurrency(e.target.value as (typeof CURRENCY_CODES)[number])}
        className="w-full bg-[rgba(255,255,255,0.04)] border border-border-dim rounded-pill px-[10px] py-[5px] font-mono text-[11px] text-[rgba(246,247,248,0.6)] cursor-pointer outline-none"
        title={
          live
            ? 'Live exchange rate'
            : 'Using an approximate offline rate — the live feed is unavailable'
        }
      >
        {CURRENCY_CODES.map((c) => (
          <option key={c} value={c} className="bg-near-black">
            {CURRENCIES[c].symbol} {c}
          </option>
        ))}
      </select>
      {/* An offline rate is plausible, not accurate. Say so rather than let a
          stale figure pass for a live one. */}
      {!live && (
        <span className="text-[10px] text-[rgba(246,247,248,0.35)] whitespace-nowrap" title="Offline rate">
          approx
        </span>
      )}
    </label>
  )
}
