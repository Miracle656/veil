'use client'

import { useEffect, useMemo, useState } from 'react'
import { redirect, useRouter } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { attachPrivacyProgress, getPrivacyClient, toUserFacingPrivacyError } from '@/lib/privacy/client'
import { isPrivacyEnabled } from '@/lib/privacy/config'

type Step = 'amount' | 'review' | 'proving' | 'complete' | 'error'

function xlmToStroops(value: string): bigint {
  const normalized = value.trim()
  if (!/^\d+(\.\d{1,7})?$/.test(normalized)) {
    throw new Error('Enter an amount with up to 7 decimal places.')
  }
  const [whole, fraction = ''] = normalized.split('.')
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0'))
}

export default function ShieldPage() {
  if (!isPrivacyEnabled()) redirect('/dashboard')

  const router = useRouter()
  const [step, setStep] = useState<Step>('amount')
  const [amount, setAmount] = useState('1')
  const [proofState, setProofState] = useState('Preparing deposit…')
  const [error, setError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const cleanup = attachPrivacyProgress((event) => {
      setProofState(event.message || 'Preparing proof…')
    })

    return cleanup
  }, [])

  const invalidAmount = useMemo(() => {
    const value = Number(amount)
    return !Number.isFinite(value) || value <= 0 || !/^\d+(\.\d{1,7})?$/.test(amount.trim())
  }, [amount])

  const handleShield = async () => {
    setError(null)
    setLoading(true)

    try {
      setStep('proving')
      const client = await getPrivacyClient()
      const result = await client.shield(xlmToStroops(amount))
      setTxHash(result)
      setStep('complete')
    } catch (caught) {
      setError(toUserFacingPrivacyError(caught))
      setStep('error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="wallet-shell" style={{ padding: '1.5rem 1.25rem 4rem' }}>
      <div style={{ maxWidth: 480, width: '100%', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.75rem' }}>
          <button
            type="button"
            onClick={() => router.push('/dashboard')}
            aria-label="Back to dashboard"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--off-white)', display: 'flex', padding: 0 }}
          >
            <ChevronLeft size={22} strokeWidth={1.75} />
          </button>
          <h1 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.375rem', color: 'var(--off-white)' }}>
            Shield into private balance
          </h1>
        </div>

        {step === 'amount' && (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.5)', letterSpacing: '0.06em', fontFamily: 'Anton, Impact, sans-serif' }}>
              DEPOSIT
            </p>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.875rem', color: 'rgba(246,247,248,0.8)' }}>
              Amount in XLM
              <input
                aria-label="Shield amount"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                inputMode="decimal"
                placeholder="1.0"
                style={{
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid var(--border-dim)',
                  borderRadius: 12,
                  padding: '0.9rem 0.95rem',
                  color: 'var(--off-white)',
                  fontSize: '1rem',
                }}
              />
            </label>

            <div className="card" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-dim)', padding: '0.85rem 1rem' }}>
              <p style={{ color: 'rgba(246,247,248,0.7)', fontSize: '0.8125rem', lineHeight: 1.6 }}>
                This deposit is public on chain. The private part starts after the note is created inside the pool.
              </p>
            </div>

            <button
              type="button"
              className="btn-gold"
              onClick={() => setStep('review')}
              disabled={invalidAmount || loading}
              style={{ width: '100%' }}
            >
              Review shield
            </button>
          </div>
        )}

        {step === 'review' && (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <p style={{ fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em', fontSize: '0.75rem', color: 'rgba(246,247,248,0.5)' }}>
              REVIEW
            </p>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: 'rgba(246,247,248,0.6)' }}>Amount</span>
              <strong style={{ color: 'var(--off-white)' }}>{amount} XLM</strong>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: 'rgba(246,247,248,0.6)' }}>Payment source</span>
              <strong style={{ color: 'var(--off-white)' }}>Spending account</strong>
            </div>

            <div style={{ padding: '1rem', borderRadius: 12, border: '1px solid var(--border-dim)', background: 'rgba(255,255,255,0.02)' }}>
              <p style={{ fontWeight: 600, color: 'var(--off-white)', marginBottom: '0.5rem' }}>What stays public</p>
              <p style={{ color: 'rgba(246,247,248,0.72)', lineHeight: 1.6 }}>
                The deposit itself is visible on chain. The public transaction proves the move into the pool; later pool activity is private.
              </p>
            </div>

            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button type="button" className="btn-ghost" onClick={() => setStep('amount')} style={{ flex: 1 }}>
                Edit
              </button>
              <button type="button" className="btn-gold" onClick={handleShield} disabled={loading} style={{ flex: 1 }}>
                {loading ? 'Preparing…' : 'Confirm deposit'}
              </button>
            </div>
          </div>
        )}

        {step === 'proving' && (
          <div className="card" style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '1rem', alignItems: 'center' }}>
            <div className="spinner spinner-light" />
            <p style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.125rem', color: 'var(--off-white)' }}>
              Proving…
            </p>
            <p style={{ color: 'rgba(246,247,248,0.6)', lineHeight: 1.6, maxWidth: 320 }}>
              {proofState}
            </p>
          </div>
        )}

        {step === 'complete' && (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <p style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.2rem', color: 'var(--off-white)' }}>
              Deposit created
            </p>
            <p style={{ color: 'rgba(246,247,248,0.7)', lineHeight: 1.6 }}>
              The public ledger shows the deposit, and the private balance inside the pool is now syncing.
            </p>
            {txHash && (
              <div className="address-chip" style={{ justifyContent: 'center', fontSize: '0.75rem', wordBreak: 'break-all' }}>
                {txHash}
              </div>
            )}
            <button type="button" className="btn-gold" onClick={() => router.push('/dashboard')} style={{ width: '100%' }}>
              Back to wallet
            </button>
          </div>
        )}

        {step === 'error' && (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <p style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.2rem', color: 'var(--off-white)' }}>
              Shield failed
            </p>
            <p style={{ color: 'rgba(246,247,248,0.75)', lineHeight: 1.6 }}>{error || 'Privacy proof could not be completed.'}</p>
            <button type="button" className="btn-gold" onClick={() => setStep('amount')} style={{ width: '100%' }}>
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
