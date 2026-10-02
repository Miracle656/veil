'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft, LockKeyhole, Check } from 'lucide-react'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import {
  type IdleTimeout,
  IDLE_TIMEOUT_OPTIONS,
  DEFAULT_IDLE_TIMEOUT,
  getIdleTimeout,
  setIdleTimeout,
} from '@/lib/idle-lock'

function optionLabel(option: IdleTimeout): string {
  return option === 'never' ? 'Never' : `${option} minutes`
}

const OPTION_DESC: Record<string, string> = {
  '5': 'Most secure',
  '15': 'Recommended',
  '30': 'Relaxed',
  never: 'Not recommended — auto-lock disabled',
}

export default function SecuritySettingsPage() {
  const router = useRouter()
  useInactivityLock()

  // Read the persisted value after mount to avoid a hydration mismatch.
  const [selected, setSelected] = useState<IdleTimeout>(DEFAULT_IDLE_TIMEOUT)
  useEffect(() => {
    setSelected(getIdleTimeout())
  }, [])

  function choose(option: IdleTimeout) {
    setIdleTimeout(option)
    setSelected(option)
  }

  return (
    <div className="wallet-shell" style={{ padding: '1.5rem 1.25rem 4rem' }}>
      <div style={{ maxWidth: 480, width: '100%', margin: '0 auto' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.75rem' }}>
          <button
            type="button"
            onClick={() => router.push('/settings')}
            aria-label="Back to settings"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--off-white)', display: 'flex', padding: 0 }}
          >
            <ChevronLeft size={22} strokeWidth={1.75} />
          </button>
          <h1 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.375rem', color: 'var(--off-white)' }}>
            Security
          </h1>
        </div>

        {/* Auto-lock section */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', marginBottom: '0.5rem' }}>
          <LockKeyhole size={16} color="var(--gold)" strokeWidth={1.75} />
          <p style={{ fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em', fontSize: '0.75rem', color: 'rgba(246,247,248,0.5)' }}>
            AUTO-LOCK
          </p>
        </div>
        <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', lineHeight: 1.6, marginBottom: '1rem' }}>
          Lock the wallet and require your passkey again after a period of inactivity. Switching
          tabs or apps restarts the timer.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
          {IDLE_TIMEOUT_OPTIONS.map((option) => {
            const isSelected = option === selected
            return (
              <button
                key={String(option)}
                type="button"
                onClick={() => choose(option)}
                className="card"
                aria-pressed={isSelected}
                style={{
                  textAlign: 'left',
                  cursor: 'pointer',
                  width: '100%',
                  background: 'var(--surface)',
                  border: `1px solid ${isSelected ? 'var(--gold)' : 'var(--border-dim)'}`,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem' }}>
                  <div>
                    <p style={{ fontWeight: 500, fontSize: '0.9375rem', color: 'var(--off-white)' }}>
                      {optionLabel(option)}
                    </p>
                    <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.25rem' }}>
                      {OPTION_DESC[String(option)]}
                    </p>
                  </div>
                  {isSelected && <Check size={18} color="var(--gold)" strokeWidth={2} style={{ flexShrink: 0 }} />}
                </div>
              </button>
            )
          })}
        </div>

        {selected === 'never' && (
          <p style={{ fontSize: '0.75rem', color: 'rgba(252,165,165,0.9)', marginTop: '1rem', lineHeight: 1.5 }}>
            With auto-lock off, anyone with access to this device can use your wallet without
            re-verifying. Only choose this on a device you fully trust.
          </p>
        )}
      </div>
    </div>
  )
}
