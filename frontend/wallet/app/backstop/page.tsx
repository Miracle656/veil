'use client'

import { PageHeader } from '@/components/ui/primitives'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { VeilMark } from '@/components/ui/VeilMark'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import { walletLocal, walletSession } from '@/lib/walletStorage'
import { BackstopDisclosure, hasAcknowledgedBackstop } from '@veil/backstop-disclosure'

const DEFAULT_POOL = {
  id: 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD',
  name: 'Fixed',
}

export default function BackstopPage() {
  const router = useRouter()
  useInactivityLock()

  const [acknowledged, setAcknowledged] = useState(false)
  const [depositAmount, setDepositAmount] = useState('')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

  useEffect(() => {
    const addr = walletSession.getItem('invisible_wallet_address')
    if (!addr) {
      router.replace('/lock')
      return
    }

    hasAcknowledgedBackstop(DEFAULT_POOL.id).then((ack) => {
      setAcknowledged(ack)
    })
  }, [router])

  async function handleDeposit() {
    if (!acknowledged) {
      setErrorMsg('You must review and acknowledge the first-loss capital disclosure before depositing.')
      return
    }
    if (!depositAmount || parseFloat(depositAmount) <= 0) {
      setErrorMsg('Please enter a valid amount.')
      return
    }
    setStatusMsg('Deposit action submitted.')
  }

  return (
    <div className="wallet-shell">
      <nav className="wallet-nav">
        <button
          onClick={() => router.push('/earn')}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--off-white)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.375rem',
            fontSize: '0.875rem',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Earn
        </button>
        <VeilMark size={22} />
        <div style={{ width: 40 }} />
      </nav>

      <main className="wallet-main">
        <div style={{ marginBottom: '1.75rem' }}>
          <PageHeader eyebrow="First-Loss Capital" title="Backstop" />
        </div>

        <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.6)', marginBottom: '1.25rem', lineHeight: 1.5 }}>
          Backstop depositors provide first-loss protection behind the lending pool. Withdrawals are subject to a 17-day queue.
        </p>

        {/* ── The ONE shared disclosure component ── */}
        <BackstopDisclosure
          poolId={DEFAULT_POOL.id}
          poolName={DEFAULT_POOL.name}
          onAcknowledge={() => setAcknowledged(true)}
        />

        {/* ── Deposit Section ── */}
        <div
          className="card"
          style={{
            padding: '1.25rem',
            border: '1px solid var(--border-dim)',
            marginBottom: '1rem',
          }}
        >
          <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', marginBottom: '0.5rem' }}>
            Pool: {DEFAULT_POOL.name} Backstop
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '0.75rem' }}>
            <input
              className="input-field"
              type="number"
              placeholder="0.0"
              value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value)}
              data-testid="backstop-deposit-input"
              style={{ flex: 1, fontSize: '1.5rem', background: 'none', border: 'none', padding: 0 }}
            />
            <span style={{ color: 'rgba(246,247,248,0.4)', fontSize: '0.875rem' }}>
              BLND:USDC LP
            </span>
          </div>

          <button
            className="btn-gold"
            data-testid="backstop-deposit-button"
            style={{ width: '100%', marginTop: '0.5rem' }}
            disabled={!acknowledged || !depositAmount || parseFloat(depositAmount) <= 0}
            onClick={handleDeposit}
          >
            Deposit into backstop
          </button>
        </div>

        {errorMsg && (
          <p style={{ color: 'var(--red, #f87171)', fontSize: '0.8125rem', marginTop: '0.5rem' }}>
            {errorMsg}
          </p>
        )}

        {statusMsg && (
          <p style={{ color: 'var(--teal, #2dd4bf)', fontSize: '0.8125rem', marginTop: '0.5rem' }}>
            {statusMsg}
          </p>
        )}
      </main>
    </div>
  )
}
