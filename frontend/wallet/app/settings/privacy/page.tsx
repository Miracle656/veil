'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ShieldCheck, Key, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'
import { getSentryOptIn, setSentryOptIn, initSentry } from '@/lib/sentry'
import { isPrivacyEnabled } from '@/lib/privacy/config'
import { checkPrivacyEnrollment, enrollPrivacyKey, type PrivacyEnrollmentStatus } from '@/lib/privacy/enrollment'
import { peekFeePayerKeypair, ensureFeePayer } from '@/lib/feePayer'
import { walletLocal } from '@/lib/walletStorage'
import { getNetworkName } from '@/lib/network'

export default function PrivacySettingsPage() {
  const router = useRouter()
  const [optIn, setOptIn] = useState(false)
  const [privacyEnabled, setPrivacyEnabled] = useState(false)
  const [enrollmentStatus, setEnrollmentStatus] = useState<PrivacyEnrollmentStatus | null>(null)
  const [loadingEnrollment, setLoadingEnrollment] = useState(false)
  const [enrolling, setEnrolling] = useState(false)
  const [enrollError, setEnrollError] = useState<string | null>(null)
  const [enrollSuccess, setEnrollSuccess] = useState<string | null>(null)

  const activeNetwork = getNetworkName()
  const walletAddress = typeof window !== 'undefined'
    ? walletLocal.getItem('invisible_wallet_address') || peekFeePayerKeypair()?.publicKey()
    : null

  const refreshEnrollment = useCallback(async () => {
    if (!isPrivacyEnabled(activeNetwork) || !walletAddress) {
      return
    }
    setLoadingEnrollment(true)
    try {
      const status = await checkPrivacyEnrollment({
        address: walletAddress,
        network: activeNetwork,
      })
      setEnrollmentStatus(status)
    } catch (err: unknown) {
      setEnrollmentStatus({
        enrolled: false,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setLoadingEnrollment(false)
    }
  }, [activeNetwork, walletAddress])

  useEffect(() => {
    setOptIn(getSentryOptIn())
    const enabled = isPrivacyEnabled(activeNetwork)
    setPrivacyEnabled(enabled)
    if (enabled) {
      ensureFeePayer().finally(() => {
        refreshEnrollment()
      })
    }
  }, [activeNetwork, refreshEnrollment])

  function toggle() {
    const next = !optIn
    setSentryOptIn(next)
    setOptIn(next)
    if (next) initSentry()
  }

  async function handleEnroll() {
    if (!walletAddress) {
      setEnrollError('Wallet address not available')
      return
    }
    setEnrolling(true)
    setEnrollError(null)
    setEnrollSuccess(null)

    try {
      const feePayer = peekFeePayerKeypair()
      if (!feePayer) {
        throw new Error('Passkey signer not active in this session. Please unlock your wallet.')
      }

      const res = await enrollPrivacyKey({
        address: walletAddress,
        signerSecret: feePayer.secret(),
        network: activeNetwork,
      })

      if (res.success) {
        setEnrollSuccess(
          res.alreadyEnrolled
            ? 'Privacy key is already registered in SPP registry.'
            : 'Privacy key successfully published to SPP public key registry!'
        )
        await refreshEnrollment()
      } else {
        setEnrollError(res.error || 'Failed to enrol privacy key')
      }
    } catch (err: unknown) {
      setEnrollError(err instanceof Error ? err.message : String(err))
    } finally {
      setEnrolling(false)
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

        {/* Privacy Key Enrolment section (only shown when privacy flag is enabled) */}
        {privacyEnabled && (
          <div style={{ marginBottom: '2.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', marginBottom: '0.5rem' }}>
              <Key size={16} color="var(--gold)" strokeWidth={1.75} />
              <p style={{ fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em', fontSize: '0.75rem', color: 'rgba(246,247,248,0.5)' }}>
                STELLAR PRIVATE PAYMENTS (SPP) ENROLMENT
              </p>
            </div>
            <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', lineHeight: 1.6, marginBottom: '1rem' }}>
              Publish your privacy public key to SPP’s on-chain public key registry so other Veil users can look up your key and pay you privately.
            </p>

            <div
              className="card"
              style={{
                textAlign: 'left',
                width: '100%',
                border: `1px solid ${enrollmentStatus?.enrolled ? 'rgba(74, 222, 128, 0.4)' : 'var(--border-dim)'}`,
                background: 'var(--surface)',
                padding: '1.25rem',
                borderRadius: 12,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <span style={{ fontWeight: 500, fontSize: '0.9375rem' }}>Registry Status</span>
                {loadingEnrollment ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8125rem', color: 'rgba(246,247,248,0.5)' }}>
                    <Loader2 size={14} className="animate-spin" /> Checking...
                  </span>
                ) : enrollmentStatus?.enrolled ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8125rem', color: '#4ade80', fontWeight: 600 }}>
                    <CheckCircle2 size={16} /> Enrolled
                  </span>
                ) : (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8125rem', color: 'var(--gold)', fontWeight: 600 }}>
                    <AlertCircle size={16} /> Not Enrolled
                  </span>
                )}
              </div>

              {enrollmentStatus?.enrolled && enrollmentStatus.privacyPublicKey && (
                <div style={{ marginBottom: '0.75rem' }}>
                  <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', marginBottom: '0.25rem' }}>
                    Registered Privacy Public Key:
                  </p>
                  <p style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--off-white)', wordBreak: 'break-all', background: 'rgba(0,0,0,0.2)', padding: '0.375rem 0.5rem', borderRadius: 6 }}>
                    {enrollmentStatus.privacyPublicKey}
                  </p>
                </div>
              )}

              {!enrollmentStatus?.enrolled && (
                <div style={{ marginTop: '1rem' }}>
                  <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.6)', marginBottom: '0.75rem', lineHeight: 1.5 }}>
                    Your wallet is not yet registered. Without enrolling, nobody can discover your privacy key to send you private payments.
                  </p>
                  <button
                    type="button"
                    onClick={handleEnroll}
                    disabled={enrolling}
                    style={{
                      width: '100%',
                      padding: '0.625rem 1rem',
                      background: 'var(--gold)',
                      color: '#000',
                      fontWeight: 600,
                      fontSize: '0.875rem',
                      border: 'none',
                      borderRadius: 8,
                      cursor: enrolling ? 'not-allowed' : 'pointer',
                      opacity: enrolling ? 0.7 : 1,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                    }}
                  >
                    {enrolling && <Loader2 size={16} className="animate-spin" />}
                    {enrolling ? 'Publishing key to SPP...' : 'Publish privacy key to SPP'}
                  </button>
                </div>
              )}

              {enrollSuccess && (
                <p style={{ fontSize: '0.8125rem', color: '#4ade80', marginTop: '0.75rem' }}>
                  {enrollSuccess}
                </p>
              )}

              {enrollError && (
                <p style={{ fontSize: '0.8125rem', color: '#ef4444', marginTop: '0.75rem' }}>
                  {enrollError}
                </p>
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
          onClick={toggle}
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
