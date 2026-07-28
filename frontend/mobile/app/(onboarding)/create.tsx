'use client'

import React, { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Horizon, Keypair } from '@stellar/stellar-sdk'
import { useInvisibleWallet } from '@veil/sdk'
import { deriveFeePayerKeypair } from '@/lib/deriveFeePayer'
import { walletConfig, getNetwork, buildFriendbotUrl } from '@/lib/network'
import { trackWalletCreated } from '@/lib/supabase'

const HorizonServer = Horizon.Server

type Step = 'landing' | 'registering' | 'deploying' | 'done' | 'error'

export default function MobileOnboardingCreate() {
  const router = useRouter()
  const network = getNetwork()
  const wallet = useInvisibleWallet(walletConfig)

  const [step, setStep] = useState<Step>('landing')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [username, setUsername] = useState('')

  async function handleCreate() {
    setErrorMsg(null)
    let signerKeypair: Keypair | null = null

    try {
      const hasStoredPasskey =
        !!localStorage.getItem('invisible_wallet_key_id') &&
        !!localStorage.getItem('invisible_wallet_public_key')

      if (!hasStoredPasskey) {
        setStep('registering')
        const result = await wallet.register(username || 'mobile')
        if (!result) throw new Error('Registration returned no result')
      }

      setStep('deploying')

      const credentialId = localStorage.getItem('invisible_wallet_key_id')
      if (!credentialId) throw new Error('Passkey credential not found after registration')

      signerKeypair = await deriveFeePayerKeypair(credentialId)
      const signerSecret = signerKeypair.secret()

      // Persist the signer before deploy so a failed mainnet attempt can be retried
      // after the account is funded externally.
      localStorage.setItem('veil_signer_public_key', signerKeypair.publicKey())
      localStorage.setItem('veil_signer_secret', signerSecret)

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

      // Persist minimal session state for dashboard
      sessionStorage.setItem('invisible_wallet_address', deployed.walletAddress)
      sessionStorage.setItem('veil_signer_secret', signerSecret)

      // Track creation (non-blocking)
      try {
        trackWalletCreated?.(deployed.walletAddress, signerKeypair.publicKey())
      } catch (e) {
        // ignore tracking failures
      }

      setStep('done')

      // Navigate to dashboard
      router.replace('/dashboard')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setErrorMsg(msg)
      setStep('error')

      // Provide a helpful fallback message if it's a network/funding issue
      if (
        !network.friendbotUrl &&
        signerKeypair &&
        !msg.includes(signerKeypair.publicKey()) &&
        /account|source|balance|insufficient/i.test(msg)
      ) {
        setErrorMsg('Deployment failed due to account/funding error. Try again or check the network configuration.')
      }
    }
  }

  const busy = step !== 'landing' && step !== 'done' && step !== 'error'

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      <h1 className="text-2xl font-semibold mb-4">Create a Veil Wallet</h1>

      <p className="mb-4 text-sm text-muted-foreground">Use your device passkey (biometrics) to create a private smart wallet.</p>

      {errorMsg && (
        <div className="mb-4 text-sm text-red-600">{errorMsg}</div>
      )}

      <div className="w-full max-w-md">
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
          {step === 'registering' && 'Creating passkey…'}
          {step === 'deploying' && 'Deploying wallet…'}
          {step === 'done' && 'Done — opening dashboard'}
          {step === 'error' && 'Retry'}
          {step === 'landing' && 'Create Wallet'}
        </button>

        <div className="mt-4 text-center text-sm text-muted-foreground">
          {step === 'landing' && 'Tap Create Wallet to begin.'}
          {step === 'registering' && 'Registering passkey on this device.'}
          {step === 'deploying' && 'Deploying your wallet contract on-chain.'}
          {step === 'done' && 'Wallet ready — redirecting…'}
          {step === 'error' && 'An error occurred. Read the message above and try again.'}
        </div>
      </div>
    </div>
  )
}
