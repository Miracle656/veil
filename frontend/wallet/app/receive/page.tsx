'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Keypair } from '@stellar/stellar-sdk'
import { QRCodeCanvas } from 'qrcode.react'
import { buildSep7PayUri } from '@/lib/sep7'

// ── Shared address card

interface AddressCardProps {
  label: string
  description: string
  address: string
  isPrimary?: boolean
}

function AddressCard({ label, description, address, isPrimary }: AddressCardProps) {
  const [copied, setCopied] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const qrRef = useRef<HTMLDivElement>(null)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleDownload = () => {
    if (!qrRef.current) return
    setDownloading(true)
    const canvas = qrRef.current.querySelector('canvas')
    if (!canvas) { setDownloading(false); return }

    const pad = 24
    const out = document.createElement('canvas')
    out.width  = canvas.width  + pad * 2
    out.height = canvas.height + pad * 2
    const ctx = out.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.drawImage(canvas, pad, pad)

    const link = document.createElement('a')
    link.download = `veil-${isPrimary ? 'spending' : 'contract'}-${address.slice(0, 8)}.png`
    link.href = out.toDataURL('image/png')
    link.click()
    setDownloading(false)
  }

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'My Veil Wallet Address', text: address })
      } catch { /* user dismissed */ }
      return
    }
    await navigator.clipboard.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const canShare = typeof navigator !== 'undefined' && !!navigator.share

  return (
    <div style={{
      marginBottom: '2rem',
      border: isPrimary ? '1px solid rgba(253,218,36,0.3)' : '1px solid var(--border-dim)',
      borderRadius: '16px',
      padding: '1.25rem',
      background: isPrimary ? 'rgba(253,218,36,0.04)' : 'var(--surface)',
    }}>
      {/* Label */}
      <p style={{
        fontSize: '0.6875rem',
        fontFamily: 'Anton, Impact, sans-serif',
        letterSpacing: '0.08em',
        color: isPrimary ? 'var(--gold)' : 'var(--warm-grey)',
        marginBottom: '0.375rem',
      }}>
        {label}
      </p>
      <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.55)', marginBottom: '1.25rem', lineHeight: 1.5 }}>
        {description}
      </p>

      {/* QR Code */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1.25rem' }}>
        <div
          ref={qrRef}
          style={{
            background: '#ffffff',
            borderRadius: '0.75rem',
            padding: '1rem',
            boxShadow: '0 0 0 1px var(--border-dim)',
          }}
        >
          <QRCodeCanvas
            value={buildSep7PayUri({ destination: address })}
            size={isPrimary ? 200 : 160}

            bgColor="#ffffff"
            fgColor="#0F0F0F"
            level="M"
          />

        </div>
      </div>

      {/* Address text */}
      <div className="card" style={{ marginBottom: '1rem', textAlign: 'center', padding: '0.875rem 1rem' }}>
        <p style={{
          fontFamily: 'Inconsolata, monospace',
          fontSize: '0.75rem',
          color: 'var(--off-white)',
          wordBreak: 'break-all',
          lineHeight: 1.6,
        }}>
          {address}
        </p>
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button
          className={isPrimary ? 'btn-gold' : 'btn-secondary'}
          onClick={handleCopy}
          style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem', ...(isPrimary ? {} : { border: '1.5px solid var(--border-dim)', background: 'transparent', color: 'var(--off-white)', borderRadius: '0.75rem', padding: '0.625rem', fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer' }) }}
        >
          {copied ? (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Copied!
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="2"/>
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" strokeWidth="2"/>
              </svg>
              Copy
            </>
          )}
        </button>

        <button
          onClick={handleDownload}
          disabled={downloading}
          style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem',
            border: '1.5px solid var(--border-dim)', background: 'transparent',
            color: 'var(--off-white)', borderRadius: '0.75rem', padding: '0.625rem',
            fontSize: '0.875rem', fontWeight: 600, cursor: downloading ? 'not-allowed' : 'pointer',
            opacity: downloading ? 0.6 : 1,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {downloading ? 'Saving…' : 'QR'}
        </button>

        <button
          onClick={handleShare}
          style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem',
            border: '1.5px solid var(--border-dim)', background: 'transparent',
            color: 'var(--off-white)', borderRadius: '0.75rem', padding: '0.625rem',
            fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {canShare ? 'Share' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

// ── Receive page ──────────────────────────────────────────────────────────────

export default function ReceivePage() {
  const router = useRouter()
  const [contractAddress, setContractAddress] = useState<string | null>(null)
  const [feePayerAddress, setFeePayerAddress] = useState<string | null>(null)

  useEffect(() => {
    const stored = sessionStorage.getItem('invisible_wallet_address')
    if (!stored) { router.replace('/lock'); return }
    setContractAddress(stored)

    // Derive the G... fee-payer address from session/local storage
    const signerSecret = sessionStorage.getItem('veil_signer_secret')
      || localStorage.getItem('veil_signer_secret')
    if (signerSecret) {
      try {
        setFeePayerAddress(Keypair.fromSecret(signerSecret).publicKey())
      } catch { /* malformed secret */ }
      return
    }
    const storedPub = localStorage.getItem('veil_signer_public_key')
    if (storedPub) setFeePayerAddress(storedPub)
  }, [router])

  const ready = !!contractAddress

  return (
    <div className="wallet-shell">
      <header className="wallet-nav">
        <button
          onClick={() => router.back()}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--off-white)', display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.875rem' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M19 12H5M12 19l-7-7 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Back
        </button>
        <span style={{
          fontFamily: 'Anton, Impact, sans-serif',
          fontSize: '1.25rem', letterSpacing: '0.08em',
          color: 'var(--gold)', userSelect: 'none',
        }}>
          VEIL
        </span>
      </header>

      <main className="wallet-main" style={{ paddingTop: '3rem', paddingBottom: '3rem' }}>

        <div style={{ marginBottom: '2rem', textAlign: 'center' }}>
          <h1 style={{
            fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic',
            fontSize: '1.75rem', color: 'var(--off-white)', marginBottom: '0.375rem',
          }}>
            Receive
          </h1>
          <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.5)' }}>
            Share the right address for where the sender is sending from.
          </p>
        </div>

        {!ready ? (
          <div className="spinner spinner-light" style={{ width: '2rem', height: '2rem', margin: '4rem auto' }} />
        ) : (
          <>
            {/* G... fee-payer address — primary, works with all senders */}
            {feePayerAddress ? (
              <AddressCard
                label="SPENDING ADDRESS (G…) — USE FOR MOST SENDERS"
                description="Use this address to receive XLM from exchanges, classic wallets, and most apps. Works with Coinbase, Lobstr, and any Stellar wallet."
                address={feePayerAddress}
                isPrimary
              />
            ) : (
              <div style={{
                marginBottom: '2rem', padding: '1rem 1.25rem',
                background: 'rgba(253,218,36,0.05)', border: '1px solid rgba(253,218,36,0.2)',
                borderRadius: '12px',
              }}>
                <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.55)', lineHeight: 1.5 }}>
                  Your spending address (G…) will appear here after you tap <strong style={{ color: 'var(--off-white)' }}>Fund wallet</strong> on the dashboard.
                </p>
              </div>
            )}

            {/* C... contract address — secondary, for Soroban-native senders */}
            {contractAddress && (
              <AddressCard
                label="CONTRACT ADDRESS (C…) — SOROBAN / VEIL WALLETS ONLY"
                description="Use this address only when sending from another Veil wallet or a Soroban-compatible app. Classic wallets cannot send to C… addresses."
                address={contractAddress}
              />
            )}
          </>
        )}

      </main>
    </div>
  )
}
