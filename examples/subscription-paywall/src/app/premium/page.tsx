import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { WALLET_COOKIE } from '@/lib/constants'
import { getSubscriptionStatus, type SubscriptionStatus } from '@/lib/subscription'

// Read fresh on every request — the gate depends on live on-chain state.
export const dynamic = 'force-dynamic'

export default async function PremiumPage() {
  const wallet = cookies().get(WALLET_COOKIE)?.value
  if (!wallet) redirect('/paywall?from=/premium')

  // Authoritative server-side gate: read the subscription straight from chain.
  // (The middleware performs the same check first; this re-verifies on render.)
  let status: SubscriptionStatus
  try {
    status = await getSubscriptionStatus(wallet)
  } catch {
    redirect('/paywall?from=/premium')
  }
  if (!status.active) redirect('/paywall?from=/premium')

  const expires = status.expiresAt ? new Date(status.expiresAt * 1000).toLocaleString() : null

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-6">
      <div className="w-full max-w-md space-y-4">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm text-gray-500 hover:text-gray-300">
            ← Home
          </Link>
          <h1 className="text-xl font-bold">Premium</h1>
        </div>

        <div className="rounded-2xl border border-indigo-900 bg-indigo-950/30 p-6 space-y-3">
          <span className="inline-block rounded-full bg-indigo-900 px-2 py-0.5 text-[11px] uppercase tracking-wider text-indigo-200">
            Paid
          </span>
          <h2 className="text-lg font-semibold">🎉 You&apos;re subscribed — welcome in.</h2>
          <p className="text-sm text-gray-300">
            This content is gated by Next.js middleware and re-verified here against your wallet&apos;s
            on-chain authorization to the merchant. No active subscription, no access.
          </p>
          {expires && (
            <p className="rounded-lg border border-indigo-900 bg-indigo-950/50 px-3 py-2 text-xs text-indigo-200">
              Access valid until {expires}
            </p>
          )}
        </div>

        <Link
          href="/paywall"
          className="block text-center text-sm text-gray-400 hover:text-gray-200"
        >
          Manage subscription
        </Link>
      </div>
    </main>
  )
}
