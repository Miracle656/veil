'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { getNetwork } from '@/lib/network'

export interface TxRecord {
  id: string
  type: 'sent' | 'received' | 'swapped'
  amount: string
  asset: string
  counterparty: string
  timestamp: number
  hash?: string
  memo?: string
  isPrivate?: boolean
  // swap-specific
  destAmount?: string
  destAsset?: string
}

interface TxDetailSheetProps {
  tx: TxRecord
  onClose: () => void
}

export function TxDetailSheet({ tx, onClose }: TxDetailSheetProps) {
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const date = new Date(tx.timestamp * 1000).toLocaleString()

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        aria-hidden="true"
        style={{
          position: 'fixed', inset: 0, zIndex: 40,
          background: 'rgba(15,15,15,0.7)',
        }}
      />

      {/* Sheet */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Transaction details"
        style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 50,
          background: 'var(--near-black)',
          borderTop: '1px solid var(--border-dim)',
          borderRadius: '1rem 1rem 0 0',
          padding: '1.25rem 1.5rem 2rem',
          maxWidth: 480,
          margin: '0 auto',
        }}
      >
        {/* Drag handle */}
        <div style={{
          width: 40, height: 4,
          background: 'rgba(246,247,248,0.15)',
          borderRadius: 2,
          margin: '0 auto 1.5rem',
        }} />

        <h3 style={{
          fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic',
          fontSize: '1.25rem', marginBottom: '1.5rem',
        }}>
          Transaction Details
        </h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
          <DetailRow label="Type" value={tx.type === 'sent' ? 'Sent' : tx.type === 'swapped' ? 'Swap' : 'Received'} />
          {tx.type === 'swapped' ? (
            <>
              <DetailRow label="Sent" value={`${tx.amount} ${tx.asset}`} />
              <DetailRow label="Received" value={`${tx.destAmount ?? '?'} ${tx.destAsset ?? ''}`} />
            </>
          ) : (
            <DetailRow label="Amount" value={`${tx.amount} ${tx.asset}`} />
          )}
          <DetailRow
            label={tx.type === 'sent' ? 'To' : tx.type === 'swapped' ? 'Via' : 'From'}
            value={tx.counterparty.length > 16 ? `${tx.counterparty.slice(0, 8)}...${tx.counterparty.slice(-8)}` : tx.counterparty}
            mono
          />
          <DetailRow label="Date" value={date} />
          {tx.memo && <DetailRow label="Memo" value={tx.memo} />}
          {tx.hash && (
            <DetailRow
              label="Tx Hash"
              value={`${tx.hash.slice(0, 12)}...${tx.hash.slice(-12)}`}
              mono
              href={`https://stellar.expert/explorer/${getNetwork().name === 'mainnet' ? 'public' : 'testnet'}/tx/${tx.hash}`}
            />
          )}
          {tx.isPrivate && (
            <DetailRow
              label="Privacy"
              value="Private (SPP Shielded)"
            />
          )}
        </div>

        <div style={{ marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <Link
            href={`/privacy/disclose?txId=${encodeURIComponent(tx.id)}&amount=${encodeURIComponent(tx.amount)}&asset=${encodeURIComponent(tx.asset)}&counterparty=${encodeURIComponent(tx.counterparty)}&timestamp=${tx.timestamp}&hash=${encodeURIComponent(tx.hash || '')}${tx.memo ? `&memo=${encodeURIComponent(tx.memo)}` : ''}`}
            onClick={onClose}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              textDecoration: 'none',
              padding: '0.75rem 1rem',
              borderRadius: '9999px',
              fontWeight: 600,
              fontSize: '0.875rem',
              background: 'linear-gradient(135deg, #fdda24 0%, #f3c82a 100%)',
              color: '#0a1220',
            }}
          >
            <span>🛡️</span> Prove this payment (Selective disclosure) →
          </Link>

          <button
            className="btn-ghost"
            onClick={onClose}
            style={{ width: '100%' }}
          >
            Close
          </button>
        </div>
      </div>
    </>
  )
}

function DetailRow({
  label,
  value,
  mono,
  href,
}: {
  label: string
  value: string
  mono?: boolean
  href?: string
}) {
  const valueStyle: React.CSSProperties = {
    fontSize: '0.875rem',
    fontFamily: mono ? 'Inconsolata, monospace' : 'Inter, sans-serif',
    textAlign: 'right',
    wordBreak: 'break-all',
  }
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
      <span style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', flexShrink: 0 }}>
        {label}
      </span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          style={{ ...valueStyle, color: 'var(--gold)', textDecoration: 'none', borderBottom: '1px dotted rgba(253,218,36,0.4)' }}
        >
          {value} ↗
        </a>
      ) : (
        <span style={valueStyle}>{value}</span>
      )}
    </div>
  )
}
