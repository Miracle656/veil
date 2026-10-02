'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Keypair, Horizon } from '@stellar/stellar-sdk'
import { useInvisibleWallet } from 'invisible-wallet-sdk'
import { walletConfig, network } from '@/lib/network'
import { setWalletCookie, clearWalletCookie } from '@/lib/clientCookies'

type Step = 'idle' | 'registering' | 'funding' | 'deploying' | 'done' | 'error'

export default function HomePage() {
  const wallet = useInvisibleWallet(walletConfig)

  const [address, setAddress] = useState<string | null>(null)
  const [step, setStep] = useState<Step>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [username, setUsername] = useState('')

  // Restore a previously created wallet and re-sync the gating cookie.
  useEffect(() => {
    const stored = localStorage.getItem('invisible_wallet_address')
    if (stored) {
      setAddress(stored)
      setWalletCookie(stored)
    }
  }, [])

  async function handleCreate() {
    setErrorMsg(null)
    try {
      // 1. Register passkey
      setStep('registering')
      await wallet.register(username || undefined)

      // 2. Generate a fee-payer keypair and fund it via Friendbot
      setStep('funding')
      const feePayer = Keypair.random()
      localStorage.setItem('veil_fee_payer_secret', feePayer.secret())

      if (network.friendbotUrl) {
        const res = await fetch(`${network.friendbotUrl}?addr=${feePayer.publicKey()}`)
        if (!res.ok) throw new Error('Friendbot funding failed — try again in a moment.')
      } else {
        const horizon = new Horizon.Server(network.horizonUrl)
        await horizon.loadAccount(feePayer.publicKey()).catch(() => {
          throw new Error(
            `Mainnet requires a funded fee-payer. Fund ${feePayer.publicKey()} with XLM then try again.`,
          )
        })
      }

      // 3. Deploy the wallet contract via the factory
      setStep('deploying')
      const { walletAddress } = await wallet.deploy(feePayer.secret())
      localStorage.setItem('invisible_wallet_address', walletAddress)
      setWalletCookie(walletAddress)
      setAddress(walletAddress)

      setStep('done')
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
      setStep('error')
    }
  }

  function handleDisconnect() {
    localStorage.removeItem('invisible_wallet_address')
    clearWalletCookie()
    setAddress(null)
    setStep('idle')
  }

  const stepLabel: Record<Step, string> = {
    idle: '',
    registering: 'Creating passkey…',
    funding: 'Funding fee-payer via Friendbot…',
    deploying: 'Deploying wallet on Stellar…',
    done: 'Done!',
    error: '',
  }
  const busy = step === 'registering' || step === 'funding' || step === 'deploying'

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-3xl font-bold tracking-tight">Veil Subscription Paywall</h1>
          <p className="text-sm text-gray-400">
            Recurring on-chain access · Passkey-powered · Stellar Testnet
          </p>
        </div>

        {/* Free content — always visible */}
        <div className="rounded-2xl border border-gray-800 bg-gray-900 p-6 space-y-2">
          <span className="inline-block rounded-full bg-gray-800 px-2 py-0.5 text-[11px] uppercase tracking-wider text-gray-400">
            Free
          </span>
          <h2 className="text-lg font-semibold">Welcome — this page is open to everyone.</h2>
          <p className="text-sm text-gray-400">
            Premium content lives behind a paywall gated by an on-chain subscription. Create a
            passkey wallet, then unlock access with a single recurring authorization.
          </p>
        </div>

        {!address ? (
          <div className="rounded-2xl border border-gray-800 bg-gray-900 p-6 space-y-4">
            <input
              type="text"
              placeholder="Username (optional)"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={busy}
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
            />
            <button
              onClick={handleCreate}
              disabled={busy}
              className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold transition-colors hover:bg-indigo-500 disabled:opacity-50"
            >
              {busy ? stepLabel[step] : 'Create wallet with passkey'}
            </button>
            <p className="text-center text-xs text-gray-600">
              Your key never leaves your device. Powered by WebAuthn passkeys.
            </p>
          </div>
        ) : (
          <div className="rounded-2xl border border-gray-800 bg-gray-900 p-6 space-y-4">
            <div className="space-y-1">
              <p className="text-xs uppercase tracking-wider text-gray-500">Wallet</p>
              <p className="break-all font-mono text-xs text-gray-300">{address}</p>
            </div>
            <div className="flex flex-col gap-2">
              <Link
                href="/premium"
                className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-center text-sm font-semibold transition-colors hover:bg-indigo-500"
              >
                Go to premium content
              </Link>
              <Link
                href="/paywall"
                className="w-full rounded-lg border border-gray-700 px-4 py-2.5 text-center text-sm font-semibold transition-colors hover:bg-gray-800"
              >
                Manage subscription
              </Link>
              <button
                onClick={handleDisconnect}
                className="text-center text-xs text-gray-500 hover:text-gray-300"
              >
                Disconnect this device
              </button>
            </div>
          </div>
        )}

        {errorMsg && (
          <p className="rounded-lg border border-red-800 bg-red-950 px-4 py-3 text-sm text-red-300">
            {errorMsg}
          </p>
        )}
      </div>
    </main>
  )
}
