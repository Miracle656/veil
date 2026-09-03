'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Horizon, Keypair } from '@stellar/stellar-sdk'
import { VeilMark } from '@/components/ui/VeilMark'
import { OnboardingTutorial } from '@/components/OnboardingTutorial'
import { useInvisibleWallet } from '@veil/sdk'
import { ensureFeePayer } from '@/lib/feePayer'
import { buildFriendbotUrl, getNetwork, walletConfig } from '@/lib/network'
import { trackWalletCreated } from '@/lib/supabase'
import { walletLocal, walletSession } from '@/lib/walletStorage'

const network = getNetwork()
const HorizonServer = Horizon.Server

type Step = 'landing' | 'registering' | 'deploying' | 'done'

export default function OnboardingPage() {
  const router = useRouter()
  const [step, setStep] = useState<Step>('landing')
  const [error, setError] = useState<string | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  const [showTutorial, setShowTutorial] = useState(false)

  useEffect(() => {
    // If a wallet already exists, go straight to the lock/unlock screen
    const existingWallet = walletLocal.getItem('invisible_wallet_address')
    if (existingWallet) {
      router.replace('/lock')
      return
    }
    const seen = localStorage.getItem('veil_seen_tutorial')
    if (!seen) {
      setShowTutorial(true)
    }
  }, [])

  const handleTutorialComplete = () => {
    localStorage.setItem('veil_seen_tutorial', '1')
    setShowTutorial(false)
  }

  const wallet = useInvisibleWallet(walletConfig)

  async function handleCreate() {
    setError(null)
    let success = false
    let signerKeypair: Keypair | null = null
    try {
      const hasStoredPasskey =
        !!walletLocal.getItem('invisible_wallet_key_id')
        && !!walletLocal.getItem('invisible_wallet_public_key')

      if (!hasStoredPasskey) {
        setStep('registering')
        const result = await wallet.register()
        if (!result) throw new Error('Registration returned no result')
      }

      setStep('deploying')
      // Derive fee-payer deterministically from the passkey credential ID.
      // On cache clear the same passkey → same credential ID → same keypair.
      const credentialId = walletLocal.getItem('invisible_wallet_key_id')
      if (!credentialId) throw new Error('Passkey credential not found after registration')
      // Establish the fee-payer for this new wallet. Fresh wallets use the
      // passkey-bound PRF derivation (ADR 0003); authenticators without PRF fall
      // back to the legacy credential-ID derivation. ensureFeePayer persists the
      // seed per mode — PRF → sessionStorage only, legacy → localStorage.
      const established = await ensureFeePayer()
      if (!established) throw new Error('Could not establish fee-payer key')
      signerKeypair = established
      const signerSecret = signerKeypair.secret()

      // The public key is not secret — keep it in localStorage for display and
      // funding retries regardless of derivation mode.
      walletLocal.setItem('veil_signer_public_key', signerKeypair.publicKey())

      const friendbotUrl = buildFriendbotUrl(signerKeypair.publicKey())
      if (friendbotUrl) {
        const friendbotRes = await fetch(friendbotUrl)
        if (!friendbotRes.ok) throw new Error('Friendbot funding failed — try again')
      } else {
        const horizonServer = new HorizonServer(network.horizonUrl)
        try {
          await horizonServer.loadAccount(signerKeypair.publicKey())
        } catch {
          throw new Error(
            `Mainnet deployment requires a funded signer account. Fund ${signerKeypair.publicKey()} with XLM for fees, then tap Create wallet again.`
          )
        }
      }

      // Pass secret string so the SDK uses its own Keypair instance internally,
      // avoiding XDR type mismatches between two stellar-sdk copies.
      const deployed = await wallet.deploy(signerSecret)

      // Persist minimal session to sessionStorage for the dashboard. The
      // fee-payer secret is already in sessionStorage (ensureFeePayer set it).
      walletSession.setItem('invisible_wallet_address', deployed.walletAddress)
      setAddress(deployed.walletAddress)
      setStep('done')
      success = true

      // Track wallet creation (fire-and-forget — never blocks the flow)
      trackWalletCreated(deployed.walletAddress, signerKeypair.publicKey())
    } catch (err: unknown) {
      let msg = err instanceof Error ? err.message : String(err)
      if (
        !network.friendbotUrl
        && signerKeypair
        && !msg.includes(signerKeypair.publicKey())
        && /account|source|balance|insufficient/i.test(msg)
      ) {
        msg = `Mainnet deployment requires a funded signer account. Fund ${signerKeypair.publicKey()} with XLM for fees, then tap Create wallet again.`
      }
      setError(msg)
      setStep('landing')
    }

    // Navigate outside try/catch so a routing error can't reset the page to 'landing'
    if (success) {
      await new Promise(r => setTimeout(r, 1200))
      router.push('/dashboard')
    }
  }

  function handleContinue() {
    router.push('/dashboard')
  }

  return (
    <>
    <main>
      {showTutorial && <OnboardingTutorial onComplete={handleTutorialComplete} />}
      <div
        className="wallet-shell"
        style={{ justifyContent: 'center', alignItems: 'center', padding: '2rem 1.25rem', minHeight: '100dvh' }}
      >
        <div style={{ maxWidth: 400, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>

          {/* ── Hero ── */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2rem', marginBottom: '3rem', textAlign: 'center' }}>

            {/* Biometric pulse ring */}
            <div className="biometric-pulse" style={{ width: 96, height: 96 }}>
              <VeilMark size={64} />
            </div>

            {/* Headline + lede */}
            <div>
              <h1
                style={{
                  fontFamily: 'Lora, Georgia, serif',
                  fontWeight: 600,
                  fontStyle: 'italic',
                  fontSize: 'clamp(1.75rem, 6vw, 2.25rem)',
                  lineHeight: 1.25,
                  color: 'var(--off-white)',
                  marginBottom: '1rem',
                }}
              >
                Your passkey is{' '}
                <span className="hl" style={{ color: 'var(--gold)', fontStyle: 'italic' }}>
                  your wallet.
                </span>
              </h1>
              <p style={{ fontSize: '0.9375rem', color: 'rgba(246,247,248,0.5)', lineHeight: 1.6 }}>
                No seed phrase. No password. Just your biometric — securing a smart contract wallet on Stellar.
              </p>
            </div>
          </div>

          {/* ── CTAs ── */}
          {step === 'landing' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', width: '100%' }}>
              <button id="onboarding-create" className="btn-gold" onClick={handleCreate}>
                Create wallet
              </button>
              <button id="onboarding-recover" className="btn-ghost" onClick={() => router.push('/recover')}>
                Recover existing wallet
              </button>
              {error && (
                <p style={{ fontSize: '0.8125rem', color: 'var(--teal)', textAlign: 'center', marginTop: '0.5rem' }}>
                  {error}
                </p>
              )}
            </div>
          )}

          {/* ── In-progress states ── */}
          {(step === 'registering' || step === 'deploying') && (
            <div className="card" style={{ textAlign: 'center', width: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1rem' }}>
                <div className="spinner spinner-light" />
              </div>
              <p style={{ fontFamily: 'Inter', fontWeight: 500, color: 'var(--off-white)' }}>
                {step === 'registering' ? 'Waiting for biometric...' : 'Deploying wallet on-chain...'}
              </p>
              <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.5rem' }}>
                {step === 'registering'
                  ? 'Approve the passkey prompt on your device'
                  : `Broadcasting to ${network.displayName}`}
              </p>
            </div>
          )}

          {/* ── Success ── */}
          {step === 'done' && address && (
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', width: '100%' }}>
              <div style={{ textAlign: 'center' }}>
                <svg width="40" height="40" viewBox="0 0 40 40" fill="none" style={{ margin: '0 auto 0.75rem' }}>
                  <circle cx="20" cy="20" r="19" stroke="var(--teal)" strokeWidth="1.5" />
                  <path d="M13 20.5l5 5 9-9" stroke="var(--teal)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <p style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.25rem', color: 'var(--off-white)' }}>
                  Wallet created
                </p>
              </div>

              <div>
                <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', marginBottom: '0.5rem', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em' }}>
                  YOUR WALLET ADDRESS
                </p>
                <div className="address-chip" style={{ width: '100%', justifyContent: 'center', borderRadius: 12, padding: '0.75rem 1rem' }}>
                  {address.slice(0, 8)}...{address.slice(-8)}
                </div>
              </div>

              <button className="btn-gold" onClick={handleContinue}>
                Open wallet
              </button>
            </div>
          )}

          {/* ── WebAuthn footnote ── */}
          <p
            id="webauthn-footnote"
            style={{ textAlign: 'center', fontSize: '0.75rem', color: 'rgba(246,247,248,0.3)', marginTop: '2.5rem' }}
          >
            Secured by{' '}
            <span style={{ color: 'rgba(246,247,248,0.6)' }}>WebAuthn</span>
            {' '}on{' '}
            <span style={{ color: 'rgba(246,247,248,0.6)' }}>Stellar</span>
          </p>

        </div>
      </div>
    </main>
    </>
  )
}
