'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Keypair, Horizon } from '@stellar/stellar-sdk'
import { useInvisibleWallet } from 'invisible-wallet-sdk'
import { walletConfig, network } from '@/lib/network'

type Step = 'idle' | 'registering' | 'funding' | 'deploying' | 'done' | 'error'

export default function HomePage() {
  const router = useRouter()
  const wallet = useInvisibleWallet(walletConfig)

  const [step, setStep] = useState<Step>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [username, setUsername] = useState('')

  // If a wallet is already stored, go straight to dashboard
  useEffect(() => {
    if (localStorage.getItem('invisible_wallet_address')) {
      router.replace('/dashboard')
    }
  }, [router])

  async function handleCreate() {
    setErrorMsg(null)
    try {
      // ── 1. Register passkey ──────────────────────────────────────────────
      setStep('registering')
      await wallet.register(username || undefined)

      // ── 2. Generate a fee-payer keypair and fund it via Friendbot ────────
      setStep('funding')
      const feePayer = Keypair.random()
      localStorage.setItem('veil_fee_payer_secret', feePayer.secret())

      if (network.friendbotUrl) {
        const res = await fetch(`${network.friendbotUrl}?addr=${feePayer.publicKey()}`)
        if (!res.ok) throw new Error('Friendbot funding failed — try again in a moment.')
      } else {
        // Mainnet: verify the account exists (must be pre-funded externally)
        const horizon = new Horizon.Server(network.horizonUrl)
        await horizon.loadAccount(feePayer.publicKey()).catch(() => {
          throw new Error(
            `Mainnet requires a funded fee-payer. Fund ${feePayer.publicKey()} with XLM then try again.`
          )
        })
      }

      // ── 3. Deploy the wallet contract via the factory ────────────────────
      setStep('deploying')
      const { walletAddress } = await wallet.deploy(feePayer.secret())
      localStorage.setItem('invisible_wallet_address', walletAddress)

      setStep('done')
      router.push('/dashboard')
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
      setStep('error')
    }
  }

  async function handleLogin() {
    setErrorMsg(null)
    // Wallet address is already in localStorage — just go to dashboard
    const stored = localStorage.getItem('invisible_wallet_address')
    if (stored) {
      router.push('/dashboard')
    } else {
      setErrorMsg('No wallet found on this device. Create one first.')
    }
  }

  const stepLabel: Record<Step, string> = {
    idle: '',
    registering: 'Creating passkey…',
    funding: 'Funding fee-payer via Friendbot…',
    deploying: 'Deploying wallet on Stellar…',
    done: 'Done!',
    error: '',
  }

  const busy = step !== 'idle' && step !== 'done' && step !== 'error'

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-3xl font-bold tracking-tight">Veil Wallet</h1>
          <p className="text-sm text-gray-400">Passkey-powered · Stellar Testnet</p>
        </div>

        <div className="rounded-2xl border border-gray-800 bg-gray-900 p-6 space-y-4">
          <input
            type="text"
            placeholder="Username (optional)"
            value={username}
            onChange={e => setUsername(e.target.value)}
            disabled={busy}
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
          />

          <button
            onClick={handleCreate}
            disabled={busy}
            className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold hover:bg-indigo-500 disabled:opacity-50 transition-colors"
          >
            {busy ? stepLabel[step] : 'Create wallet with passkey'}
          </button>

          <button
            onClick={handleLogin}
            disabled={busy}
            className="w-full rounded-lg border border-gray-700 px-4 py-2.5 text-sm font-semibold hover:bg-gray-800 disabled:opacity-50 transition-colors"
          >
            I already have a wallet
          </button>
        </div>

        {errorMsg && (
          <p className="rounded-lg border border-red-800 bg-red-950 px-4 py-3 text-sm text-red-300">
            {errorMsg}
          </p>
        )}

        <p className="text-center text-xs text-gray-600">
          Your key never leaves your device. Powered by WebAuthn passkeys.
        </p>
      </div>
    </main>
  )
}
