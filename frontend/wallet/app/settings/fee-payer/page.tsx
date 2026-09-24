'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft, Fuel, Copy, Check, AlertTriangle } from 'lucide-react'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import {
  ensureFeePayer,
  peekFeePayerKeypair,
  getFeePayerMode,
  getFeePayerDiagnostics,
  isFeePayerPrfDowngrade,
  formatFeePayerDiagnostics,
  type FeePayerMode,
  type FeePayerDiagnostics,
} from '@/lib/feePayer'

const MODE_LABEL: Record<FeePayerMode, string> = {
  'prf-raw': 'PRF (raw)',
  'prf-hkdf': 'PRF (HKDF)',
  legacy: 'Legacy (credential ID)',
}

const MODE_DESCRIPTION: Record<FeePayerMode, string> = {
  'prf-raw': 'Derived directly from a WebAuthn PRF output on this passkey — the same method the mobile app uses, so this address reproduces on a PRF-capable device.',
  'prf-hkdf': 'Derived by running a WebAuthn PRF output through HKDF — what the web wallet used before it matched mobile. Kept only because this wallet was already pinned this way.',
  legacy: 'Derived from the (non-secret) passkey credential ID. Used for wallets created before PRF support, or as a fallback when the authenticator does not support PRF.',
}

const STATUS_LABEL: Record<string, string> = {
  exists: 'found on-chain — chosen',
  'not-found': 'not found on-chain',
  'network-error': 'probe failed (network error)',
  'not-probed': 'not probed',
}

export default function FeePayerSettingsPage() {
  const router = useRouter()
  useInactivityLock()

  const [address, setAddress] = useState<string | null>(null)
  const [mode, setMode] = useState<FeePayerMode | null>(null)
  const [diagnostics, setDiagnostics] = useState<FeePayerDiagnostics | null>(null)
  const [copied, setCopied] = useState<'address' | 'diagnostics' | null>(null)

  const refresh = useCallback(() => {
    setAddress(peekFeePayerKeypair()?.publicKey() ?? null)
    setMode(getFeePayerMode())
    setDiagnostics(getFeePayerDiagnostics())
  }, [])

  useEffect(() => {
    // Idempotent and memoised — if the fee-payer is already established this
    // session (the common case, set up at dashboard mount), this resolves
    // immediately with no prompt and no re-derivation.
    ensureFeePayer().finally(refresh)
  }, [refresh])

  const downgraded = isFeePayerPrfDowngrade(diagnostics)

  async function copy(text: string, which: 'address' | 'diagnostics') {
    await navigator.clipboard.writeText(text)
    setCopied(which)
    setTimeout(() => setCopied(null), 2000)
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
            Fee Payer
          </h1>
        </div>

        <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.4)', marginBottom: '1.75rem', lineHeight: 1.6 }}>
          Your wallet contract holds your funds, but a separate account — the fee payer — signs
          and pays the network fee for every transaction. This page shows which one is active and
          how it was derived from your passkey.
        </p>

        {/* Downgrade warning */}
        {downgraded && (
          <div
            className="card-md"
            style={{ marginBottom: '1.5rem', borderLeft: '3px solid rgba(220,38,38,0.7)', display: 'flex', gap: '0.625rem', alignItems: 'flex-start' }}
          >
            <AlertTriangle size={18} color="rgba(220,38,38,0.9)" strokeWidth={1.75} style={{ flexShrink: 0, marginTop: '0.125rem' }} />
            <div>
              <p style={{ fontWeight: 600, fontSize: '0.875rem', color: 'rgba(220,38,38,0.9)', marginBottom: '0.25rem' }}>
                PRF was requested but is unavailable on this device
              </p>
              <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.5)', lineHeight: 1.5 }}>
                This wallet fell back to the legacy fee payer because this authenticator did not
                produce a WebAuthn PRF result{diagnostics?.prfError ? ` (${diagnostics.prfError})` : ''}.
                The same passkey will derive a <em>different</em> fee payer on a PRF-capable device,
                which can look like a different wallet there. Copy the diagnostics below if you need
                to report this.
              </p>
            </div>
          </div>
        )}

        {/* Active fee payer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', marginBottom: '0.625rem' }}>
          <Fuel size={16} color="var(--gold)" strokeWidth={1.75} />
          <p style={{ fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em', fontSize: '0.75rem', color: 'rgba(246,247,248,0.5)' }}>
            ACTIVE FEE PAYER
          </p>
        </div>

        <div className="card-md" style={{ marginBottom: '1.5rem' }}>
          {address ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
                <p style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.8125rem', wordBreak: 'break-all', color: 'var(--gold)' }}>
                  {address}
                </p>
                <button
                  type="button"
                  onClick={() => copy(address, 'address')}
                  aria-label="Copy fee payer address"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--off-white)', display: 'flex', flexShrink: 0, padding: '0.25rem' }}
                >
                  {copied === 'address' ? <Check size={16} color="var(--teal)" /> : <Copy size={16} strokeWidth={1.75} />}
                </button>
              </div>
              <p style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--off-white)' }}>
                {mode ? MODE_LABEL[mode] : 'Unknown'}
              </p>
              <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.25rem', lineHeight: 1.5 }}>
                {mode ? MODE_DESCRIPTION[mode] : 'The derivation mode for this wallet has not been established yet.'}
              </p>
            </>
          ) : (
            <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.3)' }}>Establishing fee payer…</p>
          )}
        </div>

        {/* Diagnostics */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.625rem' }}>
          <p style={{ fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em', fontSize: '0.75rem', color: 'rgba(246,247,248,0.5)' }}>
            DERIVATION LOG
          </p>
          {diagnostics && (
            <button
              type="button"
              onClick={() => copy(formatFeePayerDiagnostics(diagnostics), 'diagnostics')}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--teal)', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.375rem', padding: 0 }}
            >
              {copied === 'diagnostics' ? <Check size={14} /> : <Copy size={14} strokeWidth={1.75} />}
              {copied === 'diagnostics' ? 'Copied' : 'Copy for bug report'}
            </button>
          )}
        </div>

        <div className="card-md">
          {!diagnostics && (
            <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.3)' }}>
              No diagnostic log yet for this session.
            </p>
          )}

          {diagnostics && (
            <>
              <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', marginBottom: '0.75rem' }}>
                {diagnostics.probed
                  ? 'Every candidate below was derived and checked against Horizon for an existing account.'
                  : 'This wallet’s mode was already pinned, so no on-chain probe ran this session.'}
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {diagnostics.candidates.map((c) => (
                  <div key={c.mode} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', fontSize: '0.75rem' }}>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ color: c.mode === diagnostics.chosenMode ? 'var(--gold)' : 'var(--off-white)', fontWeight: 600 }}>
                        {MODE_LABEL[c.mode]}
                      </p>
                      <p style={{ fontFamily: 'Inconsolata, monospace', color: 'rgba(246,247,248,0.4)', wordBreak: 'break-all' }}>
                        {c.publicKey}
                      </p>
                    </div>
                    <p style={{ color: 'rgba(246,247,248,0.4)', flexShrink: 0, textAlign: 'right' }}>
                      {STATUS_LABEL[c.status] ?? c.status}
                    </p>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
