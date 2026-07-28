'use client'

import React, { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Horizon, Keypair } from '@stellar/stellar-sdk'
import { useInvisibleWallet } from '@veil/sdk'
import { deriveFeePayerKeypair } from '@/lib/deriveFeePayer'
import { walletConfig, getNetwork, buildFriendbotUrl } from '@/lib/network'
import { trackWalletCreated } from '@/lib/supabase'
import { QRCodeCanvas } from 'qrcode.react'

const HorizonServer = Horizon.Server

type Step = 'landing' | 'registering' | 'ready' | 'funding' | 'deploying' | 'done' | 'error'

export default function MobileOnboardingCreate() {
  const router = useRouter()
  const network = getNetwork()
  const wallet = useInvisibleWallet(walletConfig)

  const [step, setStep] = useState<Step>('landing')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [username, setUsername] = useState('')

  // Derived signer info shown before deploy
  const [signerPublicKey, setSignerPublicKey] = useState<string | null>(null)
  const [signerSecret, setSignerSecret] = useState<string | null>(null)

  // Funding UI state
  const [funding, setFunding] = useState(false)
  const [fundingError, setFundingError] = useState<string | null>(null)

  const [webAuthnSupported, setWebAuthnSupported] = useState(true)

  const qrRef = useRef<HTMLDivElement | null>(null)
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    // feature-detect WebAuthn/platform authenticator availability
    const supported = typeof window !== 'undefined' && window.isSecureContext && !!navigator.credentials
    setWebAuthnSupported(supported)
  }, [])

  async function handleCreate() {
    setErrorMsg(null)
    setFundingError(null)
    let derived: Keypair | null = null

    try {
      const hasStoredPasskey =
        !!localStorage.getItem('invisible_wallet_key_id') &&
        !!localStorage.getItem('invisible_wallet_public_key')

      if (!hasStoredPasskey) {
        setStep('registering')
        const result = await wallet.register(username || 'mobile')
        if (!result) throw new Error('Registration returned no result')
      }

      // Derive deterministic fee-payer and show before deploy so user can fund/copy it
      const credentialId = localStorage.getItem('invisible_wallet_key_id')
      if (!credentialId) throw new Error('Passkey credential not found after registration')

      derived = await deriveFeePayerKeypair(credentialId)
      const secret = derived.secret()
      const pub = derived.publicKey()

      // Persist signer so retries are possible
      localStorage.setItem('veil_signer_public_key', pub)
      localStorage.setItem('veil_signer_secret', secret)

      setSignerPublicKey(pub)
      setSignerSecret(secret)
      setStep('ready')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setErrorMsg(msg)
      setStep('error')
    }
  }

  // Download the rendered QR as a PNG (wrap canvas with white padding)
  const handleDownloadQr = () => {
    if (!qrRef.current) return
    const canvas = qrRef.current.querySelector('canvas') as HTMLCanvasElement | null
    if (!canvas) return
    setDownloading(true)

    const pad = 24
    const out = document.createElement('canvas')
    out.width = canvas.width + pad * 2
    out.height = canvas.height + pad * 2
    const ctx = out.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.drawImage(canvas, pad, pad)

    const link = document.createElement('a')
    link.download = `veil-signer-${signerPublicKey?.slice(0, 8) ?? 'key'}.png`
    link.href = out.toDataURL('image/png')
    link.click()
    setDownloading(false)
  }

  async function handleFundAndDeploy() {
    setFundingError(null)
    setErrorMsg(null)
    setFunding(true)
    setStep('funding')

    if (!signerPublicKey || !signerSecret) {
      setFundingError('Missing signer keys — restart the flow.')
      setFunding(false)
      setStep('error')
      return
    }

    try {
      const friendbotUrl = buildFriendbotUrl(signerPublicKey)
      if (friendbotUrl) {
        const res = await fetch(friendbotUrl)
        if (!res.ok) throw new Error('Friendbot funding failed — try again')
      } else {
        // Mainnet: verify the account exists (must be pre-funded externally)
        const horizon = new HorizonServer(network.horizonUrl)
        try {
          await horizon.loadAccount(signerPublicKey)
        } catch (e) {
          throw new Error(
            `Signer account ${signerPublicKey} is not funded. Fund this address with XLM for fees, then tap Fund & Deploy again.`
          )
        }
      }

      setStep('deploying')

      // Pass secret string so the SDK uses its own Keypair instance internally
      const deployed = await wallet.deploy(signerSecret)

      // Persist minimal session state for dashboard
      sessionStorage.setItem('invisible_wallet_address', deployed.walletAddress)
      sessionStorage.setItem('veil_signer_secret', signerSecret)

      // Track creation (non-blocking)
      try {
        trackWalletCreated?.(deployed.walletAddress, signerPublicKey)
      } catch (e) {
        // ignore
      }

      setFunding(false)
      setStep('done')

      // Navigate to dashboard
      router.replace('/dashboard')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setFundingError(msg)
      setFunding(false)
      setStep('ready')
    }
  }

  const copyToClipboard = async (text?: string | null) => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
    } catch (_) {
      // ignore
    }
  }

  const busy = step === 'registering' || funding || step === 'deploying' || step === 'funding'

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      <h1 className="text-2xl font-semibold mb-4">Create a Veil Wallet</h1>

      {!webAuthnSupported && (
        <div className="mb-4 text-sm text-yellow-600">
          WebAuthn / platform authenticator not available in this context. Ensure you are on HTTPS or http://localhost and your device supports a platform authenticator.
        </div>
      )}

      <p className="mb-4 text-sm text-muted-foreground">Use your device passkey (biometrics) to create a private smart wallet.</p>

      {errorMsg && (
        <div className="mb-4 text-sm text-red-600">{errorMsg}</div>
      )}

      <div className="w-full max-w-md">
        {step === 'landing' && (
          <>
            <label className="block mb-2 text-sm">Username (optional)</label>
            <input
              className="w-full rounded border px-3 py-2 mb-4"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. alice"
              disabled={busy}
            />

            <button
              onClick={handleCreate}
              disabled={busy}
              className="w-full bg-teal-600 text-white rounded py-2 disabled:opacity-60"
            >
              Create Wallet
            </button>

            <div className="mt-4 text-center text-sm text-muted-foreground">Tap Create Wallet to begin.</div>
          </>
        )}

        {step === 'registering' && (
          <div className="text-center py-6">
            <div className="spinner" />
            <div className="mt-3 text-sm">Creating passkey… Approve the platform authenticator prompt on your device.</div>
          </div>
        )}

        {step === 'ready' && signerPublicKey && (
          <div className="space-y-4">
            <div>
              <div className="text-xs text-gray-500 mb-1">Derived signer public key</div>
              <div className="rounded border px-3 py-2 font-mono break-all flex items-center justify-between">
                <span className="text-sm">{signerPublicKey}</span>
                <div className="flex items-center gap-2 ml-2">
                  <button
                    className="text-sm text-blue-600"
                    onClick={() => copyToClipboard(signerPublicKey)}
                  >
                    Copy
                  </button>
                </div>
              </div>
              <div className="text-xs text-gray-500 mt-2">You can fund this address manually (mainnet) or let Friendbot fund it for testnet.</div>
            </div>

            {/* QR code and download */}
            <div className="flex flex-col items-center gap-2">
              <div ref={qrRef} style={{ background: '#fff', padding: 12, borderRadius: 12 }}>
                <QRCodeCanvas value={signerPublicKey} size={160} includeMargin={true} />
              </div>
              <div className="flex gap-2 w-full">
                <button
                  onClick={() => copyToClipboard(signerPublicKey)}
                  className="flex-1 rounded border px-3 py-2 text-sm"
                >
                  Copy Address
                </button>
                <button
                  onClick={handleDownloadQr}
                  className="px-3 rounded bg-gray-100"
                  disabled={downloading}
                >
                  {downloading ? 'Downloading…' : 'Download QR'}
                </button>
              </div>
            </div>

            {fundingError && (
              <div className="text-sm text-red-600">{fundingError}</div>
            )}

            <div className="flex gap-2">
              <button
                onClick={handleFundAndDeploy}
                disabled={busy}
                className="flex-1 bg-purple-600 text-white rounded py-2 disabled:opacity-60"
              >
                {funding ? 'Funding…' : 'Fund & Deploy'}
              </button>
              <button
                onClick={() => {
                  // allow retrying registration from scratch
                  localStorage.removeItem('invisible_wallet_key_id')
                  localStorage.removeItem('invisible_wallet_public_key')
                  localStorage.removeItem('veil_signer_public_key')
                  localStorage.removeItem('veil_signer_secret')
                  setSignerPublicKey(null)
                  setSignerSecret(null)
                  setErrorMsg(null)
                  setFundingError(null)
                  setStep('landing')
                }}
                className="px-3 rounded border"
              >
                Start over
              </button>
            </div>

            {!buildFriendbotUrl(signerPublicKey) && (
              <div className="text-xs text-gray-500 mt-2">No Friendbot configured for this network — if you're on mainnet, copy the public key and fund it externally before tapping Fund & Deploy.</div>
            )}
          </div>
        )}

        {step === 'deploying' && (
          <div className="text-center py-6">
            <div className="spinner" />
            <div className="mt-3 text-sm">Deploying wallet on-chain…</div>
          </div>
        )}

        {step === 'done' && (
          <div className="text-center">
            <div className="text-green-600 font-semibold mb-2">Wallet created — redirecting to dashboard…</div>
          </div>
        )}

        {step === 'error' && (
          <div className="space-y-3">
            <div className="text-sm text-red-600">{errorMsg}</div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  // retry whole flow
                  setErrorMsg(null)
                  setFundingError(null)
                  setSignerPublicKey(null)
                  setSignerSecret(null)
                  setStep('landing')
                }}
                className="flex-1 bg-teal-600 text-white rounded py-2"
              >
                Retry
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
