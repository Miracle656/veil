'use client'

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  previewTransaction,
  formatAmount,
  type TxPreview,
} from '@/lib/simulate'

interface TxPreviewCardProps {
  /** Unsigned Soroban transaction XDR to preview before the passkey prompt. */
  xdr: string
  rpcUrl?: string
  networkPassphrase?: string
  tokenDecimals?: Record<string, number>
  /**
   * Called once the preview resolves. Parents should disable signing when the
   * result is `{ status: 'blocked' }` — a failed simulation is a hard block.
   */
  onResult?: (preview: TxPreview) => void
}

export function TxPreviewCard({
  xdr,
  rpcUrl,
  networkPassphrase,
  tokenDecimals,
  onResult,
}: TxPreviewCardProps) {
  const [preview, setPreview] = useState<TxPreview | null>(null)
  const [loading, setLoading] = useState(true)

  // Read callback/options via refs so inline props don't re-trigger the effect.
  const onResultRef = useRef(onResult)
  onResultRef.current = onResult
  const tokenDecimalsRef = useRef(tokenDecimals)
  tokenDecimalsRef.current = tokenDecimals

  useEffect(() => {
    let active = true
    setLoading(true)
    setPreview(null)

    previewTransaction({
      xdr,
      rpcUrl,
      networkPassphrase,
      tokenDecimals: tokenDecimalsRef.current,
    })
      .then((result) => {
        if (!active) return
        setPreview(result)
        onResultRef.current?.(result)
      })
      .catch((err: unknown) => {
        if (!active) return
        const blocked: TxPreview = {
          status: 'blocked',
          error: err instanceof Error ? err.message : String(err),
        }
        setPreview(blocked)
        onResultRef.current?.(blocked)
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [xdr, rpcUrl, networkPassphrase])

  if (loading) {
    return (
      <div style={cardStyle} aria-busy="true">
        <p style={mutedStyle}>Simulating transaction…</p>
      </div>
    )
  }

  if (!preview) return null

  if (preview.status === 'blocked') {
    return (
      <div
        role="alert"
        style={{
          ...cardStyle,
          border: '1px solid var(--border-dim)',
          borderLeft: '3px solid #e5484d',
        }}
      >
        <p style={{ margin: 0, fontWeight: 600, color: '#e5484d' }}>
          ⚠ Cannot simulate this transaction
        </p>
        <p style={{ ...mutedStyle, marginTop: '0.5rem' }}>
          Signing is blocked until the transaction can be simulated successfully.
        </p>
        <p
          style={{
            ...mutedStyle,
            marginTop: '0.5rem',
            fontFamily: 'monospace',
            fontSize: '0.75rem',
            wordBreak: 'break-word',
          }}
        >
          {preview.error}
        </p>
      </div>
    )
  }

  const { transfers, swap, feeStroops, functionName } = preview

  return (
    <div style={cardStyle} aria-label="Transaction preview">
      <p style={{ margin: 0, fontWeight: 600, color: 'var(--off-white)' }}>
        Review transaction
      </p>

      {transfers.length === 0 && !swap && (
        <p style={{ ...mutedStyle, marginTop: '0.75rem' }}>
          {functionName
            ? `Calls ${functionName} — no token movement detected.`
            : 'No token movement detected.'}
        </p>
      )}

      {transfers.map((transfer, index) => (
        <Row
          key={`${transfer.token ?? 'token'}-${index}`}
          label="You send"
          value={`${transfer.display} ${shorten(transfer.token)}`}
        />
      ))}

      {swap?.minReceiveDisplay && (
        <Row
          label="You receive at least"
          value={swap.minReceiveDisplay}
          accent
        />
      )}
      {swap?.estimatedReceiveDisplay && (
        <Row label="Estimated receive" value={swap.estimatedReceiveDisplay} />
      )}

      {feeStroops && (
        <Row label="Network fee" value={`~${formatAmount(BigInt(feeStroops), 7)} XLM`} />
      )}
    </div>
  )
}

function Row({
  label,
  value,
  accent,
}: {
  label: string
  value: string
  accent?: boolean
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: '1rem',
        marginTop: '0.75rem',
      }}
    >
      <span style={mutedStyle}>{label}</span>
      <span
        style={{
          fontWeight: 600,
          color: accent ? 'var(--gold)' : 'var(--off-white)',
          textAlign: 'right',
          wordBreak: 'break-word',
        }}
      >
        {value}
      </span>
    </div>
  )
}

/** Shortens a long contract id for display; passes short labels through. */
function shorten(value: string | null): string {
  if (!value) return 'token'
  if (value.length <= 12) return value
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

const cardStyle: CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border-dim)',
  borderRadius: '0.75rem',
  padding: '1rem 1.25rem',
  maxWidth: 480,
}

const mutedStyle: CSSProperties = {
  margin: 0,
  color: 'var(--warm-grey)',
  fontSize: '0.875rem',
}
