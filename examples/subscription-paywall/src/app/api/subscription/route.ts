import { NextResponse, type NextRequest } from 'next/server'
import { WALLET_COOKIE } from '@/lib/constants'
import { getSubscriptionStatus } from '@/lib/subscription'

// The Stellar SDK is not Edge-safe — pin this handler to the Node.js runtime.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Reads the caller's subscription status from chain. The wallet address comes from
 * the `wallet` query param (used by the middleware) or the wallet cookie.
 */
export async function GET(req: NextRequest) {
  const wallet =
    req.nextUrl.searchParams.get('wallet')?.trim() ||
    req.cookies.get(WALLET_COOKIE)?.value ||
    ''

  if (!wallet) {
    return NextResponse.json({ active: false, expiresAt: null, remaining: 0, wallet: null })
  }

  try {
    const status = await getSubscriptionStatus(wallet)
    return NextResponse.json({ ...status, wallet })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // On a read failure we fail closed (inactive) so gated content stays locked.
    return NextResponse.json({ active: false, expiresAt: null, remaining: 0, wallet, error: message })
  }
}
