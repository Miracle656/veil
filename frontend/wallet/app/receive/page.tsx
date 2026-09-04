'use client'

import { PageHeader } from '@/components/ui/primitives'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { Keypair } from '@stellar/stellar-sdk'
import { QRCodeCanvas } from 'qrcode.react'
import { buildSep7PayUri } from '@/lib/sep7'
import { walletLocal, walletSession } from '@/lib/walletStorage'
import { CURRENCIES, hydrateCurrency, useCurrency, type CurrencyCode } from '@/lib/currency'
import { fetchPrice } from '@/lib/fetchPrice'
import { downloadBrandedQr } from '@/lib/downloadBrandedQr'

const REQUEST_CHIPS: Record<CurrencyCode, number[]> = {
  USD: [5, 10, 25, 50],
  NGN: [2000, 5000, 10000, 20000],
  KES: [500, 1000, 2500, 5000],
  GHS: [50, 100, 250, 500],
  ZAR: [50, 100, 250, 500],
  GBP: [5, 10, 25, 50],
  EUR: [5, 10, 25, 50],
}

function shorten(address: string, head = 12, tail = 12): string {
  return address.length > head + tail + 1
    ? `${address.slice(0, head)}…${address.slice(-tail)}`
    : address
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}

function CopyIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="2"/>
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" strokeWidth="2"/>
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function ShareIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function HexagonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 2l8 4.5v11L12 22l-8-4.5v-11L12 2z" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round"/>
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function Tile({
  label,
  onClick,
  disabled,
  icon,
  primary,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  icon: ReactNode
  primary?: boolean
}) {
  return (
    <button
      type="button"
      className={primary ? 'vw-recv-tile vw-recv-tile--gold' : 'vw-recv-tile'}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="vw-recv-tile__face vw-recv-swap" key={label}>
        {icon}
        {label}
      </span>
    </button>
  )
}

function SpendingCard({ address }: { address: string }) {
  const [copied, setCopied] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [xlmUsd, setXlmUsd] = useState<number | null>(null)
  const [requestFiat, setRequestFiat] = useState<number | null>(null)
  const qrRef = useRef<HTMLDivElement>(null)
  const { code, rate } = useCurrency()
  const chips = REQUEST_CHIPS[code]
  const symbol = CURRENCIES[code].symbol

  useEffect(() => {
    hydrateCurrency()
    void fetchPrice('XLM', null).then(setXlmUsd)
  }, [])

  const xlmAmount =
    requestFiat != null && xlmUsd != null && xlmUsd > 0 && rate > 0
      ? (requestFiat / rate / xlmUsd).toFixed(7).replace(/\.?0+$/, '')
      : undefined
  const payUri = buildSep7PayUri({ destination: address, amount: xlmAmount })

  const handleCopy = async () => {
    if (!(await copyText(address))) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  const handleSaveQr = async () => {
    if (!qrRef.current) return
    const canvas = qrRef.current.querySelector('canvas')
    if (!canvas) return
    setDownloading(true)
    try {
      await downloadBrandedQr({
        qrCanvas: canvas,
        filename: `veil-spending-${address.slice(0, 8)}.png`,
        address,
      })
    } finally {
      setDownloading(false)
    }
  }

  const handleShare = async () => {
    const payload = xlmAmount ? payUri : address
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'My Veil Wallet Address', text: payload })
      } catch { /* user dismissed */ }
      return
    }
    await handleCopy()
  }

  return (
    <div className="vw-spendcard">
      <p className="vw-spendcard__label">Spending address</p>
      <p className="vw-spendcard__sub">Use this for most senders &amp; exchanges</p>

      <div className="vw-more" style={{ marginTop: 14, justifyContent: 'center' }}>
        {chips.map((amount) => (
          <button
            key={amount}
            type="button"
            className={requestFiat === amount ? 'vw-chip vw-chip--active' : 'vw-chip'}
            onClick={() => setRequestFiat((current) => current === amount ? null : amount)}
          >
            {symbol}{amount.toLocaleString('en-US')}
          </button>
        ))}
      </div>
      {xlmAmount && (
        <p className="vw-spendcard__sub" style={{ marginTop: 8 }}>
          QR asks for {xlmAmount} XLM
        </p>
      )}

      <div ref={qrRef} className="vw-qrframe">
        <QRCodeCanvas
          value={payUri}
          size={200}
          bgColor="#ffffff"
          fgColor="#0F0F0F"
          level="M"
        />
      </div>

      <p className="vw-spendcard__addr">{address}</p>

      <div className="vw-recv-tiles">
        <Tile primary label={copied ? 'Copied' : 'Copy'} onClick={handleCopy} icon={copied ? <CheckIcon /> : <CopyIcon />} />
        <Tile label={downloading ? 'Saving…' : 'Save QR'} onClick={handleSaveQr} disabled={downloading} icon={<DownloadIcon />} />
        <Tile label="Share" onClick={handleShare} icon={<ShareIcon />} />
      </div>
    </div>
  )
}

function ContractRow({ address }: { address: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    if (!(await copyText(address))) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      type="button"
      className="vw-contract-row"
      onClick={handleCopy}
      aria-label={copied ? 'Contract address copied' : 'Copy contract address'}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <span className="vw-contract-row__badge"><HexagonIcon /></span>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 14, fontWeight: 600 }}>Contract address</span>
          <span className="vw-meta" style={{ display: 'block', marginTop: 1 }}>
            {copied ? 'Copied' : `${shorten(address, 6, 6)} · Soroban wallets only`}
          </span>
        </span>
      </span>
      <span className="vw-contract-row__copy" aria-hidden="true">
        <span className="vw-recv-swap" key={copied ? 'copied' : 'copy'}>
          {copied ? <CheckIcon /> : <CopyIcon />}
        </span>
      </span>
    </button>
  )
}

export default function ReceivePage() {
  const router = useRouter()
  const [contractAddress, setContractAddress] = useState<string | null>(null)
  const [feePayerAddress, setFeePayerAddress] = useState<string | null>(null)

  useEffect(() => {
    const stored = walletSession.getItem('invisible_wallet_address')
    if (!stored) { router.replace('/lock'); return }
    setContractAddress(stored)

    const signerSecret = walletSession.getItem('veil_signer_secret')
      || walletLocal.getItem('veil_signer_secret')
    if (signerSecret) {
      try {
        setFeePayerAddress(Keypair.fromSecret(signerSecret).publicKey())
      } catch { /* malformed secret */ }
      return
    }
    const storedPub = walletLocal.getItem('veil_signer_public_key')
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
        <div style={{ marginBottom: '2rem' }}>
          <PageHeader eyebrow="Deposit" title="Receive" />
          <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.5)', marginTop: '0.5rem' }}>
            Share the spending address with most senders. The contract address is for Soroban wallets only.
          </p>
        </div>

        {!ready ? (
          <div className="spinner spinner-light" style={{ width: '2rem', height: '2rem', margin: '4rem auto' }} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {feePayerAddress ? (
                <SpendingCard address={feePayerAddress} />
              ) : (
                <div className="vw-spendcard" style={{ alignItems: 'flex-start' }}>
                  <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.55)', lineHeight: 1.5 }}>
                    Your spending address (G…) will appear here after you tap <strong style={{ color: 'var(--off-white)' }}>Fund wallet</strong> on the dashboard.
                  </p>
                </div>
              )}

              {contractAddress && <ContractRow address={contractAddress} />}
          </div>
        )}
      </main>
    </div>
  )
}
