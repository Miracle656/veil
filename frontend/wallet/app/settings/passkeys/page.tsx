'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Keypair } from '@stellar/stellar-sdk'
import { ChevronLeft, KeyRound, Plus, Trash2 } from 'lucide-react'
import { useInvisibleWallet, type SignerInfo } from '@veil/sdk'
import { walletConfig } from '@/lib/network'
import { useInactivityLock } from '@/hooks/useInactivityLock'

export default function PasskeysPage() {
  const router = useRouter()
  useInactivityLock()

  const [signers, setSigners] = useState<SignerInfo[]>([])
  const [localPublicKey, setLocalPublicKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null)

  const wallet = useInvisibleWallet(walletConfig)

  function getSignerKeypair(): Keypair {
    const secret = sessionStorage.getItem('veil_signer_secret')
    if (!secret) throw new Error('No signer key in session')
    return Keypair.fromSecret(secret)
  }

  const fetchSigners = useCallback(async () => {
    try {
      const list = await wallet.getSigners()
      setSigners(list)
    } catch (e) {
      console.error('Failed to fetch signers', e)
    }
  }, [wallet.getSigners])

  useEffect(() => {
    const addr = sessionStorage.getItem('invisible_wallet_address')
    if (!addr) { router.replace('/lock'); return }
    fetchSigners()
    if (typeof window !== 'undefined') {
      setLocalPublicKey(localStorage.getItem('invisible_wallet_public_key'))
    }
  }, [router, fetchSigners])

  async function handleAddPasskey() {
    setLoading(true)
    setStatus(null)
    try {
      const signerKeypair = getSignerKeypair()
      const result = await wallet.register()
      if (!result?.publicKeyBytes) throw new Error('Registration returned no public key')
      const res = await wallet.addSigner(signerKeypair, result.publicKeyBytes)
      setStatus({ text: `New passkey added at index ${res.signerIndex}`, ok: true })
      await fetchSigners()
    } catch (err: unknown) {
      setStatus({ text: err instanceof Error ? err.message : String(err), ok: false })
    } finally {
      setLoading(false)
    }
  }

  async function handleRemovePasskey(index: number) {
    if (signers.length <= 1) return
    setLoading(true)
    setStatus(null)
    try {
      const signerKeypair = getSignerKeypair()
      await wallet.removeSigner(signerKeypair, index)
      setStatus({ text: `Passkey #${index} removed`, ok: true })
      await fetchSigners()
    } catch (err: unknown) {
      setStatus({ text: err instanceof Error ? err.message : String(err), ok: false })
    } finally {
      setLoading(false)
    }
  }

  const chevronRight = (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <path d="M6 3l5 5-5 5" stroke="rgba(246,247,248,0.3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
  void chevronRight

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
            Passkeys
          </h1>
        </div>

        <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.4)', marginBottom: '1.75rem', lineHeight: 1.6 }}>
          Each passkey is a separate device credential. Adding a second passkey on a backup laptop or phone lets you recover access if one device is lost.
        </p>

        {/* Section label */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', marginBottom: '0.625rem' }}>
          <KeyRound size={16} color="var(--gold)" strokeWidth={1.75} />
          <p style={{ fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em', fontSize: '0.75rem', color: 'rgba(246,247,248,0.5)' }}>
            REGISTERED PASSKEYS
          </p>
        </div>

        {/* Signers list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem', marginBottom: '1.5rem' }}>
          {signers.length === 0 && (
            <div className="card-md" style={{ textAlign: 'center', padding: '1.5rem' }}>
              <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.3)' }}>Loading passkeys…</p>
            </div>
          )}

          {signers.map((s) => {
            const isThisDevice = localPublicKey === s.publicKey
            const truncated = `0x${s.publicKey.slice(0, 12)}…${s.publicKey.slice(-8)}`
            const canRemove = signers.length > 1

            return (
              <div
                key={s.index}
                className="card-md"
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem' }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <p style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--off-white)' }}>
                      #{s.index}
                    </p>
                    {isThisDevice && (
                      <span style={{
                        fontSize: '0.625rem',
                        background: 'rgba(94, 234, 212, 0.1)',
                        color: 'var(--teal)',
                        padding: '0.125rem 0.375rem',
                        borderRadius: '4px',
                        textTransform: 'uppercase',
                        letterSpacing: '0.02em',
                        flexShrink: 0,
                      }}>
                        This device
                      </span>
                    )}
                  </div>
                  <p style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.25rem', wordBreak: 'break-all' }}>
                    {truncated}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => handleRemovePasskey(s.index)}
                  disabled={loading || !canRemove}
                  aria-label={`Remove passkey #${s.index}`}
                  title={canRemove ? `Remove passkey #${s.index}` : 'Cannot remove the last passkey'}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: canRemove ? 'pointer' : 'not-allowed',
                    color: canRemove ? 'rgba(220,38,38,0.8)' : 'rgba(246,247,248,0.1)',
                    display: 'flex',
                    alignItems: 'center',
                    flexShrink: 0,
                    padding: '0.25rem',
                  }}
                >
                  <Trash2 size={16} strokeWidth={1.75} />
                </button>
              </div>
            )
          })}
        </div>

        {/* Status */}
        {status && (
          <div className="card-md" style={{ marginBottom: '1rem', borderLeft: `3px solid ${status.ok ? 'var(--teal)' : 'rgba(220,38,38,0.6)'}` }}>
            <p style={{ fontSize: '0.875rem', color: status.ok ? 'var(--teal)' : 'rgba(220,38,38,0.9)' }}>
              {status.text}
            </p>
          </div>
        )}

        {/* Add passkey button */}
        <button
          type="button"
          className="btn-gold"
          onClick={handleAddPasskey}
          disabled={loading}
          style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
        >
          {loading ? (
            <span className="spinner" />
          ) : (
            <>
              <Plus size={16} strokeWidth={2} />
              Add passkey
            </>
          )}
        </button>

        <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.3)', marginTop: '0.875rem', lineHeight: 1.5 }}>
          Adding a passkey prompts a new biometric registration on this device. The new credential is stored on-chain alongside existing ones.
        </p>
      </div>
    </div>
  )
}
