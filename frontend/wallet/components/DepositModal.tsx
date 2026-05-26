'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  discoverAnchorInfo,
  getSep10Jwt,
  initiateDeposit,
  initiateWithdraw,
  getTransactionStatus,
  isSep24Complete,
} from '@/lib/sep24'

// ── Anchor config ─────────────────────────────────────────────────────────────

const DEFAULT_ANCHOR = 'testanchor.stellar.org'

function getAnchors(): string[] {
  const env = process.env.NEXT_PUBLIC_SEP24_ANCHORS
  if (env) return env.split(',').map(s => s.trim()).filter(Boolean)
  return [DEFAULT_ANCHOR]
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Mode = 'deposit' | 'withdraw'
type Step = 'idle' | 'auth' | 'opening' | 'polling' | 'done' | 'error'

interface Props {
  mode: Mode
  walletAddress: string
  onClose: () => void
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const color =
    status === 'completed'                    ? 'var(--teal)'  :
    status === 'error' || status === 'expired' ? '#ef4444'     :
    'var(--gold)'

  return (
    <span style={{
      display: 'inline-block',
      padding: '0.2rem 0.6rem',
      borderRadius: '100px',
      fontSize: '0.75rem',
      fontWeight: 600,
      background: `${color}22`,
      color,
      border: `1px solid ${color}44`,
      textTransform: 'capitalize',
    }}>
      {status.replace(/_/g, ' ')}
    </span>
  )
}

// ── Modal ─────────────────────────────────────────────────────────────────────

export function DepositModal({ mode, walletAddress, onClose }: Props) {
  const anchors   = getAnchors()
  const [anchor, setAnchor]     = useState(anchors[0])
  const [assetCode, setAsset]   = useState('USDC')
  const [step, setStep]         = useState<Step>('idle')
  const [error, setError]       = useState<string | null>(null)
  const [txStatus, setTxStatus] = useState<string | null>(null)
  const [txMessage, setTxMessage] = useState<string | null>(null)
  const [txId, setTxId]         = useState<string | null>(null)
  const jwtRef                  = useRef<string | null>(null)
  const transferServerRef       = useRef<string | null>(null)
  const pollRef                 = useRef<ReturnType<typeof setInterval> | null>(null)
  const popupRef                = useRef<Window | null>(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }, [])

  useEffect(() => () => stopPolling(), [stopPolling])

  const startPolling = useCallback((id: string) => {
    stopPolling()
    pollRef.current = setInterval(async () => {
      try {
        const tx = await getTransactionStatus(
          transferServerRef.current!,
          id,
          jwtRef.current ?? undefined,
        )
        setTxStatus(tx.status)
        setTxMessage(tx.message ?? null)
        if (isSep24Complete(tx.status)) {
          stopPolling()
          setStep('done')
          popupRef.current?.close()
        }
      } catch { /* network hiccup — keep polling */ }
    }, 4_000)
  }, [stopPolling])

  const handleStart = async () => {
    setError(null)
    setStep('auth')
    try {
      // 1. Discover anchor TOML
      const info = await discoverAnchorInfo(anchor)
      transferServerRef.current = info.transferServerUrl

      // 2. SEP-10 auth — passkey signs the challenge transaction
      const jwt = await getSep10Jwt(info.webAuthEndpoint, walletAddress, info.networkPassphrase)
      jwtRef.current = jwt

      // 3. Initiate interactive flow
      setStep('opening')
      const params = { assetCode, account: walletAddress }
      const result = mode === 'deposit'
        ? await initiateDeposit(info.transferServerUrl, params, jwt)
        : await initiateWithdraw(info.transferServerUrl, params, jwt)

      setTxId(result.id)

      // 4. Open anchor interactive URL in a popup
      const popup = window.open(result.url, 'sep24_anchor', 'width=480,height=700,noopener')
      popupRef.current = popup

      // 5. Start polling for status
      setStep('polling')
      startPolling(result.id)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(
        msg.includes('NotAllowedError') || msg.includes('cancelled')
          ? 'Passkey verification was cancelled. Please try again.'
          : msg,
      )
      setStep('error')
    }
  }

  const handleClose = () => {
    stopPolling()
    popupRef.current?.close()
    onClose()
  }

  const title = mode === 'deposit' ? 'Deposit' : 'Withdraw'

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${title} via anchor`}
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)',
      }}
      onClick={e => { if (e.target === e.currentTarget) handleClose() }}
    >
      <div
        style={{
          width: '100%', maxWidth: '480px',
          background: 'var(--surface)',
          borderRadius: '20px 20px 0 0',
          padding: '1.5rem 1.25rem 2rem',
          border: '1px solid var(--border-dim)',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
          <h2 style={{ fontFamily: 'Lora, Georgia, serif', fontStyle: 'italic', fontSize: '1.25rem', color: 'var(--off-white)', margin: 0 }}>
            {title}
          </h2>
          <button
            onClick={handleClose}
            aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(246,247,248,0.4)', fontSize: '1.25rem', lineHeight: 1, padding: '0.25rem' }}
          >
            ×
          </button>
        </div>

        {/* Anchor selector */}
        {anchors.length > 1 && (
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ fontSize: '0.75rem', color: 'var(--warm-grey)', fontFamily: 'Anton, sans-serif', letterSpacing: '0.08em', display: 'block', marginBottom: '0.375rem' }}>
              ANCHOR
            </label>
            <select
              value={anchor}
              onChange={e => setAnchor(e.target.value)}
              disabled={step !== 'idle' && step !== 'error'}
              style={{
                width: '100%', padding: '0.625rem 0.875rem',
                background: 'var(--surface-raised)', border: '1px solid var(--border-dim)',
                borderRadius: '10px', color: 'var(--off-white)', fontSize: '0.9375rem',
              }}
            >
              {anchors.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
        )}

        {/* Asset selector */}
        <div style={{ marginBottom: '1.25rem' }}>
          <label style={{ fontSize: '0.75rem', color: 'var(--warm-grey)', fontFamily: 'Anton, sans-serif', letterSpacing: '0.08em', display: 'block', marginBottom: '0.375rem' }}>
            ASSET
          </label>
          <select
            value={assetCode}
            onChange={e => setAsset(e.target.value)}
            disabled={step !== 'idle' && step !== 'error'}
            style={{
              width: '100%', padding: '0.625rem 0.875rem',
              background: 'var(--surface-raised)', border: '1px solid var(--border-dim)',
              borderRadius: '10px', color: 'var(--off-white)', fontSize: '0.9375rem',
            }}
          >
            <option value="USDC">USDC</option>
            <option value="XLM">XLM</option>
          </select>
        </div>

        {/* Status area */}
        {step === 'auth' && (
          <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.625rem', color: 'rgba(246,247,248,0.6)', fontSize: '0.875rem' }}>
            <div className="spinner" style={{ width: '14px', height: '14px', flexShrink: 0 }} />
            Authenticating with passkey…
          </div>
        )}

        {step === 'opening' && (
          <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.625rem', color: 'rgba(246,247,248,0.6)', fontSize: '0.875rem' }}>
            <div className="spinner" style={{ width: '14px', height: '14px', flexShrink: 0 }} />
            Opening anchor…
          </div>
        )}

        {(step === 'polling' || step === 'done') && txStatus && (
          <div style={{ marginBottom: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', marginBottom: '0.375rem' }}>
              {step === 'polling' && <div className="spinner" style={{ width: '12px', height: '12px', flexShrink: 0 }} />}
              <StatusBadge status={txStatus} />
            </div>
            {txMessage && (
              <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.5)', marginTop: '0.375rem' }}>
                {txMessage}
              </p>
            )}
            {txId && (
              <p style={{ fontSize: '0.6875rem', color: 'rgba(246,247,248,0.3)', fontFamily: 'Inconsolata, monospace', marginTop: '0.25rem' }}>
                ID: {txId}
              </p>
            )}
          </div>
        )}

        {step === 'error' && error && (
          <div style={{
            marginBottom: '1rem', padding: '0.75rem 1rem',
            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)',
            borderRadius: '10px', fontSize: '0.875rem', color: '#fca5a5',
          }}>
            {error}
          </div>
        )}

        {/* CTA */}
        {step === 'done' ? (
          <button className="btn-gold" onClick={handleClose} style={{ width: '100%' }}>
            Done
          </button>
        ) : (
          <button
            className="btn-gold"
            onClick={step === 'idle' || step === 'error' ? handleStart : undefined}
            disabled={step === 'auth' || step === 'opening' || step === 'polling'}
            style={{ width: '100%' }}
          >
            {step === 'auth'    ? 'Verifying passkey…' :
             step === 'opening' ? 'Opening anchor…'    :
             step === 'polling' ? 'Waiting for anchor…' :
             `${title} with ${anchor}`}
          </button>
        )}

        <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.3)', textAlign: 'center', marginTop: '0.875rem' }}>
          Powered by {anchor} · SEP-24
        </p>
      </div>
    </div>
  )
}
