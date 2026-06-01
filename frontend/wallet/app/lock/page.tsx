'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { LockKeyhole, Fingerprint, AlertCircle } from 'lucide-react'
import { useInvisibleWallet } from '@veil/sdk'
import { deriveStoredFeePayer } from '@/lib/deriveFeePayer'
import { walletConfig } from '@/lib/network'

// ── Lock screen ───────────────────────────────────────────────────────────────
export default function LockPage() {
  const router = useRouter()

  const wallet = useInvisibleWallet(walletConfig)

  const [error, setError]           = useState<string | null>(null)
  const [isUnlocking, setIsUnlocking] = useState(false)

  const handleUnlock = useCallback(async () => {
    setError(null)
    setIsUnlocking(true)

    try {
      // Step 1 — Require a real WebAuthn biometric assertion.
      // wallet.login() only checks localStorage + chain; it doesn't prompt the
      // device. We call navigator.credentials.get() with userVerification:
      // 'required' so the OS always shows Face ID / fingerprint / Windows Hello.
      const keyId = localStorage.getItem('invisible_wallet_key_id')
      if (!keyId) {
        setError('No passkey found. Please register again.')
        return
      }

      if (keyId !== 'recovery') {
        // Decode base64url key ID → ArrayBuffer
        const b64 = keyId.replace(/-/g, '+').replace(/_/g, '/')
        const binary = atob(b64)
        const idBuffer = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) idBuffer[i] = binary.charCodeAt(i)

        const challenge = crypto.getRandomValues(new Uint8Array(32))
        await navigator.credentials.get({
          publicKey: {
            challenge,
            allowCredentials: [{ id: idBuffer, type: 'public-key' }],
            userVerification: 'required',
          },
        })
      }

      // Step 2 — Biometric confirmed; verify wallet exists on-chain and restore session.
      const result = await wallet.login()

      if (!result?.walletAddress) {
        setError('No wallet found. Please register again.')
        return
      }

      const existing = sessionStorage.getItem('invisible_wallet_address')
      if (existing && existing !== result.walletAddress) {
        sessionStorage.clear()
        setError('Account mismatch detected. Please register again.')
        return
      }
      sessionStorage.setItem('invisible_wallet_address', result.walletAddress)
      // Restore fee-payer secret — derive from passkey if localStorage was cleared
      let storedSecret = localStorage.getItem('veil_signer_secret')
      if (!storedSecret) {
        const derived = await deriveStoredFeePayer()
        if (derived) {
          storedSecret = derived.secret()
          localStorage.setItem('veil_signer_secret', storedSecret)
          localStorage.setItem('veil_signer_public_key', derived.publicKey())
        }
      }
      if (storedSecret) sessionStorage.setItem('veil_signer_secret', storedSecret)

      router.replace('/dashboard')

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unlock failed. Please try again.'
      setError(message)
    } finally {
      setIsUnlocking(false)
    }
  }, [wallet, router])

  return (
    <div
      className="wallet-shell"
      style={{ justifyContent: 'center', alignItems: 'center', padding: '2rem 1.25rem' }}
    >
      <div style={{ maxWidth: 400, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2.5rem' }}>

        {/* Veil wordmark — Anton ALL CAPS per Stellar brand manual */}
        <span style={{ fontFamily: 'Anton, Impact, sans-serif', fontSize: '2rem', letterSpacing: '0.08em', color: 'var(--gold)', userSelect: 'none' }}>
          VEIL
        </span>

        {/* Lock card */}
        <div
          className="card"
          style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.5rem', padding: '2.5rem 2rem' }}
        >
          {/* Lock icon */}
          <div style={{
            width: 64, height: 64, borderRadius: '50%',
            background: 'var(--surface-md)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <LockKeyhole size={28} color="rgba(246,247,248,0.6)" strokeWidth={1.5} />
          </div>

          {/* Copy — heading uses Lora SemiBold Italic per brand */}
          <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
            <h1 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.25rem', color: 'var(--off-white)' }}>
              Wallet locked
            </h1>
            <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.45)', lineHeight: 1.6 }}>
              Your session ended after 5 minutes of inactivity.
              <br />
              Verify your identity to continue.
            </p>
          </div>

          {/* Error state */}
          {error && (
            <div style={{
              width: '100%', display: 'flex', alignItems: 'flex-start', gap: '0.625rem',
              borderRadius: 12, background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.20)',
              padding: '0.75rem 1rem',
            }}>
              <AlertCircle size={16} color="rgba(252,165,165,1)" strokeWidth={1.5} style={{ flexShrink: 0, marginTop: 2 }} />
              <p style={{ fontSize: '0.875rem', color: 'rgba(252,165,165,1)', lineHeight: 1.4 }}>{error}</p>
            </div>
          )}

          {/* Unlock button — .btn-gold from globals.css */}
          <button
            type="button"
            onClick={handleUnlock}
            disabled={isUnlocking || wallet.isPending}
            className="btn-gold"
          >
            <Fingerprint size={20} strokeWidth={1.5} />
            {isUnlocking || wallet.isPending ? 'Verifying…' : 'Unlock with passkey'}
          </button>

          {/* Subtle hint */}
          <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.25)', textAlign: 'center' }}>
            Your biometric is your key — no password needed.
          </p>
        </div>
      </div>
    </div>
  )
}
