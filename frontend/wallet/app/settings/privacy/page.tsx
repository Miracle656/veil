'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ShieldCheck } from 'lucide-react'
import { getSentryOptIn, setSentryOptIn, initSentry } from '@/lib/sentry'

export default function PrivacySettingsPage() {
  const router = useRouter()
  const [optIn, setOptIn] = useState(false)

  useEffect(() => {
    setOptIn(getSentryOptIn())
  }, [])

  function toggle() {
    const next = !optIn
    setSentryOptIn(next)
    setOptIn(next)
    if (next) initSentry()
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
            Privacy
          </h1>
        </div>

        {/* Error reporting section */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', marginBottom: '0.5rem' }}>
          <ShieldCheck size={16} color="var(--gold)" strokeWidth={1.75} />
          <p style={{ fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em', fontSize: '0.75rem', color: 'rgba(246,247,248,0.5)' }}>
            ERROR REPORTING
          </p>
        </div>
        <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', lineHeight: 1.6, marginBottom: '1rem' }}>
          Help improve Veil by sending anonymous crash reports. No addresses, amounts, or
          personal data are ever included. Disabled by default.
        </p>

        <button
          type="button"
          onClick={toggle}
          className="card"
          aria-pressed={optIn}
          style={{
            textAlign: 'left',
            cursor: 'pointer',
            width: '100%',
            border: `1px solid ${optIn ? 'var(--gold)' : 'var(--border-dim)'}`,
            background: 'var(--surface)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <p style={{ fontWeight: 500, fontSize: '0.9375rem' }}>Send crash reports</p>
              <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.25rem' }}>
                {optIn ? 'Enabled — thank you for helping improve Veil' : 'Disabled'}
              </p>
            </div>
            {/* Toggle pill */}
            <div
              aria-hidden="true"
              style={{
                width: 44,
                height: 24,
                borderRadius: 12,
                background: optIn ? 'var(--gold)' : 'rgba(246,247,248,0.15)',
                position: 'relative',
                flexShrink: 0,
                transition: 'background 0.2s',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  top: 3,
                  left: optIn ? 23 : 3,
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  background: 'var(--off-white)',
                  transition: 'left 0.2s',
                }}
              />
            </div>
          </div>
        </button>

        <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.25)', marginTop: '0.75rem', lineHeight: 1.6 }}>
          Reports are sent to Sentry and contain only stack traces with wallet addresses and
          amounts stripped out. You can opt out at any time.
        </p>
      </div>
    </div>
  )
}
