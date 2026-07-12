'use client'

import { Suspense, useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Keypair } from '@stellar/stellar-sdk'
import { useInvisibleWallet } from 'invisible-wallet-sdk'
import { walletConfig, subscription, getSubscriptionToken } from '@/lib/network'
import { setWalletCookie } from '@/lib/clientCookies'

type SubStatus = { active: boolean; expiresAt: number | null; remaining: number }

export default function PaywallPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center p-6 text-sm text-gray-500">
          Loading…
        </main>
      }
    >
      <PaywallContent />
    </Suspense>
  )
}

function PaywallContent() {
  const router = useRouter()
  const params = useSearchParams()
  const wallet = useInvisibleWallet(walletConfig)

  const [address, setAddress] = useState<string | null>(null)
  const [status, setStatus] = useState<SubStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [unlocking, setUnlocking] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const refreshStatus = useCallback(async (addr: string) => {
    const res = await fetch(`/api/subscription?wallet=${encodeURIComponent(addr)}`, {
      cache: 'no-store',
    })
    setStatus((await res.json()) as SubStatus)
  }, [])

  // Restore the wallet session and read its current on-chain subscription status.
  useEffect(() => {
    const stored = localStorage.getItem('invisible_wallet_address')
    if (!stored) {
      setLoading(false)
      return
    }
    setAddress(stored)
    setWalletCookie(stored)
    // login() re-hydrates the hook so approve() can authorize later.
    wallet.login().catch(() => {})
    refreshStatus(stored)
      .catch((err) => setErrorMsg(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleUnlock() {
    setErrorMsg(null)
    if (!subscription.merchant) {
      setErrorMsg('Set NEXT_PUBLIC_MERCHANT_ADDRESS in .env.local to enable subscriptions.')
      return
    }
    if (!address || !wallet.address) {
      setErrorMsg('Wallet is still loading — try again in a moment.')
      return
    }

    setUnlocking(true)
    try {
      const feePayerSecret = localStorage.getItem('veil_fee_payer_secret')
      if (!feePayerSecret) throw new Error('Fee-payer key not found. Re-create your wallet.')
      const feePayer = Keypair.fromSecret(feePayerSecret)

      const nowSec = Math.floor(Date.now() / 1000)
      const expiry = nowSec + subscription.periodDays * 24 * 60 * 60

      // Recurring payment authorization: allow the merchant to pull up to the
      // price from this wallet until the period expires (confirmed with passkey).
      await wallet.approve(
        feePayer,
        subscription.merchant,
        getSubscriptionToken(),
        subscription.priceBaseUnits,
        expiry,
      )

      setWalletCookie(address)
      await refreshStatus(address)

      const from = params.get('from')
      router.push(from && from.startsWith('/premium') ? from : '/premium')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setErrorMsg(
        msg.includes('NotAllowedError') || msg.includes('not allowed')
          ? 'Biometric verification was cancelled. Please try again.'
          : msg,
      )
    } finally {
      setUnlocking(false)
    }
  }

  const ready = !!wallet.address
  const expiresLabel =
    status?.expiresAt != null ? new Date(status.expiresAt * 1000).toLocaleString() : null

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-6">
      <div className="w-full max-w-md space-y-4">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm text-gray-500 hover:text-gray-300">
            ← Home
          </Link>
          <h1 className="text-xl font-bold">Subscription</h1>
        </div>

        {!address ? (
          <div className="rounded-2xl border border-gray-800 bg-gray-900 p-6 space-y-3 text-center">
            <p className="text-sm text-gray-400">No wallet on this device yet.</p>
            <Link
              href="/"
              className="inline-block rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold hover:bg-indigo-500"
            >
              Create a passkey wallet
            </Link>
          </div>
        ) : (
          <div className="rounded-2xl border border-gray-800 bg-gray-900 p-6 space-y-5">
            <div className="flex items-baseline justify-between">
              <div>
                <p className="text-2xl font-bold">
                  {subscription.priceUnits} <span className="text-base font-normal">/ period</span>
                </p>
                <p className="text-xs text-gray-500">
                  Authorizes the merchant for {subscription.periodDays} days
                </p>
              </div>
              <span
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                  status?.active
                    ? 'bg-green-950 text-green-300'
                    : 'bg-gray-800 text-gray-400'
                }`}
              >
                {loading ? 'Checking…' : status?.active ? 'Active' : 'Inactive'}
              </span>
            </div>

            {status?.active && expiresLabel && (
              <p className="rounded-lg border border-green-900 bg-green-950/40 px-3 py-2 text-xs text-green-300">
                Subscribed — access until {expiresLabel}
              </p>
            )}

            <button
              onClick={handleUnlock}
              disabled={unlocking || !ready}
              className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold transition-colors hover:bg-indigo-500 disabled:opacity-50"
            >
              {unlocking
                ? 'Authorizing with passkey…'
                : !ready
                  ? 'Loading wallet…'
                  : status?.active
                    ? 'Renew subscription'
                    : 'Unlock premium — authorize recurring payment'}
            </button>

            {status?.active && (
              <Link
                href="/premium"
                className="block text-center text-sm text-indigo-400 hover:text-indigo-300"
              >
                Go to premium content →
              </Link>
            )}

            <p className="text-center text-[11px] text-gray-600">
              Subscription status is read from chain via the wallet&apos;s on-chain allowance to the
              merchant.
            </p>
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
