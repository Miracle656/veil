'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Keypair } from '@stellar/stellar-sdk'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import {
  discoverTransferServer,
  initiateDeposit,
  getTransactionStatus,
  isSep24Complete,
  type Sep24TransactionStatus,
} from '@/lib/sep24'
import { walletLocal, walletSession } from '@/lib/walletStorage'

// ── Types ─────────────────────────────────────────────────────────────────────

type Step = 'select' | 'loading' | 'iframe' | 'transak-open' | 'success' | 'error'

interface Anchor {
  id:          'transak' | 'sep24'
  name:        string
  description: string
}

const ANCHORS: Anchor[] = [
  {
    id:          'transak',
    name:        'Transak',
    description: 'Buy XLM with card or bank transfer. Fast KYC, 100+ countries.',
  },
  {
    id:          'sep24',
    name:        'Stellar Anchor',
    description: 'Connect to any SEP-24 compliant Stellar anchor by domain.',
  },
]

function TransakIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="1" y="4" width="22" height="16" rx="2" stroke="currentColor" strokeWidth="1.75"/>
      <path d="M1 10h22" stroke="currentColor" strokeWidth="1.75"/>
      <path d="M5 15h4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"/>
    </svg>
  )
}

function AnchorIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.75"/>
      <path d="M2 12h20M12 2a15.3 15.3 0 010 20M12 2a15.3 15.3 0 000 20" stroke="currentColor" strokeWidth="1.75"/>
    </svg>
  )
}

const ANCHOR_ICONS: Record<Anchor['id'], () => JSX.Element> = {
  transak: TransakIcon,
  sep24:   AnchorIcon,
}

// ── Buy page ──────────────────────────────────────────────────────────────────

export default function BuyPage() {
  const router = useRouter()
  useInactivityLock()

  const [step, setStep]                           = useState<Step>('select')
  const [feePayerAddress, setFeePayerAddress]     = useState<string | null>(null)
  const [selectedAnchor, setSelectedAnchor]       = useState<Anchor | null>(null)
  const [anchorDomain, setAnchorDomain]           = useState('')
  const [iframeUrl, setIframeUrl]                 = useState<string | null>(null)
  const [transakUrl, setTransakUrl]               = useState<string | null>(null)
  const [txnId, setTxnId]                         = useState<string | null>(null)
  const [txnStatus, setTxnStatus]                 = useState<Sep24TransactionStatus | null>(null)
  const [transferServerUrl, setTransferServerUrl] = useState<string | null>(null)
  const [error, setError]                         = useState<string | null>(null)

  const pollIntervalRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const stored = walletSession.getItem('invisible_wallet_address')
    if (!stored) { router.replace('/lock'); return }

    const secret = walletSession.getItem('veil_signer_secret')
      || walletLocal.getItem('veil_signer_secret')
    if (secret) {
      try { setFeePayerAddress(Keypair.fromSecret(secret).publicKey()) } catch { /* skip */ }
      return
    }
    const pub = walletLocal.getItem('veil_signer_public_key')
    if (pub) setFeePayerAddress(pub)
  }, [router])

  // ── Polling ───────────────────────────────────────────────────────────────

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
  }, [])

  const startPolling = useCallback((server: string, id: string) => {
    stopPolling()
    pollIntervalRef.current = setInterval(async () => {
      try {
        const status = await getTransactionStatus(server, id)
        setTxnStatus(status)
        if (status.status === 'completed') {
          stopPolling()
          setStep('success')
        } else if (isSep24Complete(status.status)) {
          stopPolling()
        }
      } catch {
        // Polling errors are soft — keep trying until the user closes
      }
    }, 5_000)
  }, [stopPolling])

  useEffect(() => () => stopPolling(), [stopPolling])

  // ── Transak flow — opens in new tab (X-Frame-Options blocks iframe) ────────

  const openTransak = useCallback(() => {
    if (!feePayerAddress) {
      setError('Spending wallet not set up yet. Tap "Fund wallet" on the dashboard first.')
      return
    }
    const apiKey = process.env.NEXT_PUBLIC_TRANSAK_API_KEY ?? ''
    const params = new URLSearchParams({
      network:            'stellar',
      cryptoCurrencyCode: 'XLM',
      walletAddress:      feePayerAddress,
      ...(apiKey ? { apiKey } : {}),
    })
    const url = `https://global.transak.com?${params.toString()}`
    setTransakUrl(url)
    window.open(url, '_blank')
    setStep('transak-open')
  }, [feePayerAddress])

  // ── Generic SEP-24 flow ───────────────────────────────────────────────────

  const openSep24 = async () => {
    if (!feePayerAddress) {
      setError('Spending wallet not set up yet. Tap "Fund wallet" on the dashboard first.')
      return
    }
    if (!anchorDomain.trim()) {
      setError('Please enter the anchor domain.')
      return
    }
    setStep('loading')
    setError(null)
    try {
      const server = await discoverTransferServer(anchorDomain.trim())
      setTransferServerUrl(server)
      const deposit = await initiateDeposit(server, { assetCode: 'XLM', account: feePayerAddress })
      setTxnId(deposit.id)
      setIframeUrl(deposit.url)
      setStep('iframe')
      startPolling(server, deposit.id)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not connect to anchor.')
      setStep('error')
    }
  }

  // ── Anchor selection handler ──────────────────────────────────────────────

  const handleSelectAnchor = (anchor: Anchor) => {
    setSelectedAnchor(anchor)
    setError(null)
    if (anchor.id === 'transak') openTransak()
    // For sep24, user fills in domain and taps "Connect"
  }

  // ── Transak postMessage listener (works for popup windows too) ────────────

  useEffect(() => {
    if (step !== 'transak-open') return
    const handleMessage = (event: MessageEvent) => {
      if (!event.origin.includes('transak.com')) return
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
        if (data?.event_id === 'TRANSAK_ORDER_SUCCESSFUL') setStep('success')
      } catch { /* ignore */ }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [step])

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="wallet-shell">
      <header className="wallet-nav">
        <button
          onClick={() => { stopPolling(); router.back() }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--off-white)', display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.875rem' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M19 12H5M12 19l-7-7 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Back
        </button>
        <span style={{ fontFamily: 'Anton, Impact, sans-serif', fontSize: '1.25rem', letterSpacing: '0.08em', color: 'var(--gold)', userSelect: 'none' }}>
          VEIL
        </span>
      </header>

      <main className="wallet-main" style={{ paddingTop: '3rem', paddingBottom: '3rem' }}>

        {/* ── Anchor selection ── */}
        {step === 'select' && (
          <>
            <div style={{ marginBottom: '2rem' }}>
              <h1 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.75rem', color: 'var(--off-white)', marginBottom: '0.375rem' }}>
                Buy crypto
              </h1>
              <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.5)' }}>
                Choose a provider to fund your spending wallet.
              </p>
            </div>

            {!feePayerAddress && (
              <div style={{ marginBottom: '1.5rem', padding: '1rem 1.25rem', background: 'var(--surface-md)', border: '1px solid var(--border-dim)', borderRadius: '12px' }}>
                <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.55)', lineHeight: 1.5 }}>
                  Your spending address isn&apos;t set up yet. Tap <strong style={{ color: 'var(--off-white)' }}>Fund wallet</strong> on the dashboard first so the provider knows where to send your funds.
                </p>
              </div>
            )}

            {error && (
              <p style={{ color: 'var(--teal)', fontSize: '0.8125rem', marginBottom: '1rem' }}>{error}</p>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '2rem' }}>
              {ANCHORS.map(anchor => {
                const Icon = ANCHOR_ICONS[anchor.id]
                return (
                  <button
                    key={anchor.id}
                    className="card"
                    onClick={() => handleSelectAnchor(anchor)}
                    style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '1.125rem 1.25rem', cursor: 'pointer', background: 'var(--surface)', border: 'none', textAlign: 'left', width: '100%', borderRadius: '12px' }}
                  >
                    <span style={{ color: 'var(--gold)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', width: '2.5rem', height: '2.5rem', borderRadius: '10px', background: 'var(--surface-md)', border: '1px solid var(--border-dim)' }}>
                      <Icon />
                    </span>
                    <div>
                      <p style={{ fontWeight: 600, fontSize: '0.9375rem', color: 'var(--off-white)', marginBottom: '0.25rem' }}>
                        {anchor.name}
                      </p>
                      <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.5)', lineHeight: 1.4 }}>
                        {anchor.description}
                      </p>
                    </div>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ color: 'rgba(246,247,248,0.3)', flexShrink: 0, marginLeft: 'auto' }}>
                      <path d="M9 18l6-6-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                )
              })}
            </div>

            {/* SEP-24 domain input */}
            {selectedAnchor?.id === 'sep24' && (
              <div className="card" style={{ padding: '1.25rem', marginBottom: '1rem' }}>
                <label style={{ fontSize: '0.75rem', fontFamily: 'Anton, Impact, sans-serif', color: 'var(--warm-grey)', letterSpacing: '0.08em', display: 'block', marginBottom: '0.625rem' }}>
                  ANCHOR DOMAIN
                </label>
                <input
                  type="text"
                  placeholder="e.g. testanchor.stellar.org"
                  value={anchorDomain}
                  onChange={e => setAnchorDomain(e.target.value)}
                  style={{ width: '100%', padding: '0.75rem 1rem', borderRadius: '8px', background: 'rgba(246,247,248,0.05)', border: '1px solid var(--border-dim)', color: 'var(--off-white)', fontSize: '0.875rem', fontFamily: 'Inconsolata, monospace', outline: 'none', boxSizing: 'border-box' }}
                />
                <button
                  className="btn-gold"
                  onClick={openSep24}
                  style={{ marginTop: '1rem', fontSize: '0.875rem', padding: '0.625rem 1.25rem' }}
                >
                  Connect to anchor
                </button>
              </div>
            )}
          </>
        )}

        {/* ── Transak opened in new tab ── */}
        {step === 'transak-open' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', paddingTop: '3rem', gap: '1.5rem' }}>
            <div style={{ width: '4rem', height: '4rem', borderRadius: '50%', background: 'var(--surface-md)', border: '1px solid var(--border-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" style={{ color: 'var(--gold)' }}>
                <rect x="1" y="4" width="22" height="16" rx="2" stroke="currentColor" strokeWidth="1.75"/>
                <path d="M1 10h22" stroke="currentColor" strokeWidth="1.75"/>
                <path d="M5 15h4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"/>
              </svg>
            </div>
            <div>
              <h2 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.5rem', color: 'var(--off-white)', marginBottom: '0.75rem' }}>
                Transak is open
              </h2>
              <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.5)', lineHeight: 1.6, maxWidth: '280px' }}>
                Complete your purchase in the browser tab that just opened. Come back here when you&apos;re done.
              </p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', width: '100%' }}>
              <button
                className="btn-gold"
                onClick={() => setStep('success')}
              >
                I&apos;ve completed my purchase
              </button>
              {transakUrl && (
                <a
                  href={transakUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ padding: '0.75rem', borderRadius: '0.75rem', border: '1px solid var(--border-dim)', background: 'transparent', color: 'rgba(246,247,248,0.6)', fontSize: '0.875rem', cursor: 'pointer', textDecoration: 'none', textAlign: 'center' }}
                >
                  Reopen Transak
                </a>
              )}
              <button
                onClick={() => { setStep('select'); setSelectedAnchor(null) }}
                style={{ padding: '0.75rem', borderRadius: '0.75rem', border: 'none', background: 'transparent', color: 'rgba(246,247,248,0.4)', fontSize: '0.875rem', cursor: 'pointer' }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* ── Loading ── */}
        {step === 'loading' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: '4rem', gap: '1rem' }}>
            <div className="spinner spinner-light" style={{ width: '2.5rem', height: '2.5rem' }} />
            <p style={{ fontSize: '0.9375rem', color: 'rgba(246,247,248,0.55)' }}>
              Connecting to {selectedAnchor?.name ?? 'anchor'}…
            </p>
          </div>
        )}

        {/* ── Iframe (SEP-24 anchors allow embedding) ── */}
        {step === 'iframe' && iframeUrl && (
          <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 8rem)' }}>
            {txnStatus && (
              <div style={{ padding: '0.625rem 1rem', marginBottom: '0.75rem', background: 'rgba(246,247,248,0.06)', borderRadius: '8px', fontSize: '0.8125rem', color: 'rgba(246,247,248,0.6)', display: 'flex', justifyContent: 'space-between' }}>
                <span>Status: <strong style={{ color: 'var(--off-white)' }}>{txnStatus.status}</strong></span>
                {txnStatus.amount_in && <span>{txnStatus.amount_in} {txnStatus.amount_in_asset}</span>}
              </div>
            )}
            <iframe
              src={iframeUrl}
              allow="payment; camera; microphone"
              style={{ flex: 1, border: 'none', borderRadius: '12px', background: '#ffffff', width: '100%' }}
              title={`${selectedAnchor?.name ?? 'Anchor'} deposit`}
            />
            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.75rem' }}>
              <button
                onClick={() => { stopPolling(); setStep('select'); setIframeUrl(null); setTxnStatus(null) }}
                style={{ flex: 1, padding: '0.75rem', borderRadius: '0.75rem', border: '1px solid var(--border-dim)', background: 'transparent', color: 'rgba(246,247,248,0.6)', fontSize: '0.875rem', cursor: 'pointer' }}
              >
                Cancel
              </button>
              {txnId && transferServerUrl && (
                <a
                  href={`${transferServerUrl}/transaction?id=${txnId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ flex: 1, padding: '0.75rem', borderRadius: '0.75rem', border: '1px solid var(--border-dim)', background: 'transparent', color: 'rgba(246,247,248,0.6)', fontSize: '0.875rem', cursor: 'pointer', textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  Check status
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ marginLeft: '0.375rem' }}>
                    <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </a>
              )}
            </div>
          </div>
        )}

        {/* ── Success ── */}
        {step === 'success' && (
          <div style={{ textAlign: 'center', paddingTop: '3rem' }}>
            <div style={{ width: '4rem', height: '4rem', borderRadius: '50%', background: 'var(--surface-md)', border: '1px solid var(--border-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.5rem' }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" style={{ color: 'var(--gold)' }}>
                <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <h2 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.5rem', color: 'var(--off-white)', marginBottom: '0.75rem' }}>
              Deposit confirmed
            </h2>
            <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.5)', marginBottom: '2rem', lineHeight: 1.5 }}>
              Your funds are on their way. It may take a few minutes for the balance to appear.
            </p>
            {txnStatus?.amount_in && (
              <p style={{ fontFamily: 'Inconsolata, monospace', fontSize: '1.25rem', color: 'var(--gold)', marginBottom: '2rem' }}>
                +{txnStatus.amount_in} {txnStatus.amount_in_asset ?? 'XLM'}
              </p>
            )}
            <button className="btn-gold" onClick={() => router.push('/dashboard')}>
              Back to dashboard
            </button>
          </div>
        )}

        {/* ── Error ── */}
        {step === 'error' && (
          <div style={{ textAlign: 'center', paddingTop: '3rem' }}>
            <div style={{ width: '4rem', height: '4rem', borderRadius: '50%', background: 'rgba(100,200,180,0.1)', border: '1px solid rgba(100,200,180,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.5rem' }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" style={{ color: 'var(--teal)' }}>
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.75"/>
                <path d="M12 8v4M12 16h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </div>
            <h2 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.5rem', color: 'var(--off-white)', marginBottom: '0.75rem' }}>
              Something went wrong
            </h2>
            {error && (
              <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.5)', marginBottom: '2rem', lineHeight: 1.5 }}>
                {error}
              </p>
            )}
            <button className="btn-gold" onClick={() => { setStep('select'); setError(null); setSelectedAnchor(null) }}>
              Try again
            </button>
          </div>
        )}

      </main>
    </div>
  )
}
