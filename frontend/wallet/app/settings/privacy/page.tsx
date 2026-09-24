'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ShieldCheck, KeyRound, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'
import { getSentryOptIn, setSentryOptIn, initSentry } from '@/lib/sentry'
import { isPrivacyEnabled, getSppConfig } from '@/lib/privacy/config'
import { checkPrivacyEnrollment, enrolPrivacyPublicKey } from '@/lib/privacy/enrollment'
import { getFeePayerMode } from '@/lib/feePayer'
import { walletLocal, walletSession } from '@/lib/walletStorage'
import { namespaceKey } from '@/lib/network'

export default function PrivacySettingsPage() {
  const router = useRouter()
  const [optIn, setOptIn] = useState(false)
  const privacyEnabled = isPrivacyEnabled()

  // SPP Enrollment state
  const [address, setAddress] = useState<string | null>(null)
  const [isEnrolled, setIsEnrolled] = useState<boolean | null>(null)
  const [isCheckingEnrollment, setIsCheckingEnrollment] = useState(false)
  const [isEnrolling, setIsEnrolling] = useState(false)
  const [enrollError, setEnrollError] = useState<string | null>(null)
  const [enrollSuccess, setEnrollSuccess] = useState<string | null>(null)
  const feePayerMode = getFeePayerMode()

  useEffect(() => {
    setOptIn(getSentryOptIn())

    if (typeof window !== 'undefined') {
      const stored =
        walletSession.getItem(namespaceKey('invisible_wallet_address')) ||
        walletLocal.getItem(namespaceKey('invisible_wallet_address')) ||
        walletLocal.getItem('invisible_wallet_address')
      if (stored) {
        setAddress(stored)
      }
    }
  }, [])

  const checkStatus = useCallback(async (walletAddr: string) => {
    if (!privacyEnabled) return
    setIsCheckingEnrollment(true)
    setEnrollError(null)
    try {
      const res = await checkPrivacyEnrollment({ address: walletAddr })
      setIsEnrolled(res.enrolled)
      if (res.error) {
        setEnrollError(res.error)
      }
    } catch (err) {
      setEnrollError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsCheckingEnrollment(false)
    }
  }, [privacyEnabled])

  useEffect(() => {
    if (address && privacyEnabled) {
      checkStatus(address)
    }
  }, [address, privacyEnabled, checkStatus])

  function toggleCrashReports() {
    const next = !optIn
    setSentryOptIn(next)
    setOptIn(next)
    if (next) initSentry()
  }

  async function handleEnrol() {
    if (!address || isEnrolling) return
    setIsEnrolling(true)
    setEnrollError(null)
    setEnrollSuccess(null)

    try {
      const res = await enrolPrivacyPublicKey({ address })
      if (res.success) {
        setIsEnrolled(true)
        setEnrollSuccess(
          res.alreadyEnrolled
            ? 'Privacy key is already registered on chain.'
            : `Privacy key successfully published to SPP registry (Tx: ${res.txHash?.slice(0, 8)}...).`
        )
      } else {
        setEnrollError(res.error || 'Failed to enrol privacy key.')
      }
    } catch (err) {
      setEnrollError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsEnrolling(false)
    }
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

        {/* SPP Privacy Key Registration (Testnet) */}
        {privacyEnabled && (
          <div style={{ marginBottom: '2.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', marginBottom: '0.5rem' }}>
              <KeyRound size={16} color="var(--gold)" strokeWidth={1.75} />
              <p style={{ fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em', fontSize: '0.75rem', color: 'rgba(246,247,248,0.5)' }}>
                STELLAR PRIVATE PAYMENTS (SPP)
              </p>
            </div>
            <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', lineHeight: 1.6, marginBottom: '1rem' }}>
              Publish your privacy public key to the on-chain SPP registry so other wallets can send you shielded payments. The key is derived deterministically from your passkey.
            </p>

            <div
              className="card"
              style={{
                width: '100%',
                border: '1px solid var(--border-dim)',
                background: 'var(--surface)',
                padding: '1.25rem',
                borderRadius: '0.75rem',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
                <div>
                  <p style={{ fontWeight: 500, fontSize: '0.9375rem', color: 'var(--off-white)' }}>
                    Privacy Key Registry Status
                  </p>
                  <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.25rem' }}>
                    {isCheckingEnrollment
                      ? 'Checking registration status...'
                      : isEnrolled
                      ? 'Enrolled — Ready to receive private payments'
                      : 'Not Enrolled — Other users cannot send to you privately'}
                  </p>
                </div>

                <div style={{ flexShrink: 0, marginLeft: '0.5rem' }}>
                  {isCheckingEnrollment ? (
                    <Loader2 size={20} className="animate-spin" color="var(--gold)" />
                  ) : isEnrolled ? (
                    <CheckCircle2 size={20} color="#22c55e" />
                  ) : (
                    <AlertCircle size={20} color="#eab308" />
                  )}
                </div>
              </div>

              {feePayerMode === 'legacy' && (
                <div
                  style={{
                    fontSize: '0.75rem',
                    color: '#f59e0b',
                    background: 'rgba(245, 158, 11, 0.1)',
                    border: '1px solid rgba(245, 158, 11, 0.3)',
                    padding: '0.625rem 0.75rem',
                    borderRadius: '0.5rem',
                    marginBottom: '1rem',
                    lineHeight: 1.5,
                  }}
                >
                  Your passkey wallet was created without PRF extension support. Private keys cannot be securely derived on this device.
                </div>
              )}

              {enrollError && (
                <div
                  style={{
                    fontSize: '0.75rem',
                    color: '#ef4444',
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    padding: '0.625rem 0.75rem',
                    borderRadius: '0.5rem',
                    marginBottom: '1rem',
                    lineHeight: 1.5,
                  }}
                >
                  {enrollError}
                </div>
              )}

              {enrollSuccess && (
                <div
                  style={{
                    fontSize: '0.75rem',
                    color: '#22c55e',
                    background: 'rgba(34, 197, 94, 0.1)',
                    border: '1px solid rgba(34, 197, 94, 0.3)',
                    padding: '0.625rem 0.75rem',
                    borderRadius: '0.5rem',
                    marginBottom: '1rem',
                    lineHeight: 1.5,
                  }}
                >
                  {enrollSuccess}
                </div>
              )}

              {!isEnrolled && (
                <button
                  type="button"
                  onClick={handleEnrol}
                  disabled={isEnrolling || isCheckingEnrollment || feePayerMode === 'legacy'}
                  style={{
                    width: '100%',
                    padding: '0.75rem 1rem',
                    background: feePayerMode === 'legacy' ? 'rgba(246,247,248,0.1)' : 'var(--gold)',
                    color: feePayerMode === 'legacy' ? 'rgba(246,247,248,0.3)' : '#000',
                    fontWeight: 600,
                    fontSize: '0.875rem',
                    borderRadius: '0.5rem',
                    border: 'none',
                    cursor: feePayerMode === 'legacy' || isEnrolling ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0.5rem',
                    transition: 'opacity 0.2s',
                  }}
                >
                  {isEnrolling && <Loader2 size={16} className="animate-spin" />}
                  {isEnrolling ? 'Publishing to Registry...' : 'Publish Privacy Key'}
                </button>
              )}
            </div>
          </div>
        )}

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
          onClick={toggleCrashReports}
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
