import { NextResponse, type NextRequest } from 'next/server'
import { WALLET_COOKIE } from '@/lib/constants'

// Gate every /premium route on subscription status. The check reads the wallet
// address from a cookie, then asks the Node route handler (which reads the
// on-chain allowance) whether the subscription is active — keeping the Stellar
// SDK out of the Edge runtime this middleware runs in.
export const config = {
  matcher: ['/premium/:path*'],
}

export async function middleware(req: NextRequest) {
  const wallet = req.cookies.get(WALLET_COOKIE)?.value
  const paywall = new URL('/paywall', req.url)
  paywall.searchParams.set('from', req.nextUrl.pathname)

  // Not connected → must subscribe first.
  if (!wallet) {
    return NextResponse.redirect(paywall)
  }

  try {
    const statusUrl = new URL('/api/subscription', req.url)
    statusUrl.searchParams.set('wallet', wallet)
    const res = await fetch(statusUrl, {
      headers: { cookie: req.headers.get('cookie') ?? '' },
    })
    const status = (await res.json()) as { active?: boolean }
    if (!status.active) {
      return NextResponse.redirect(paywall)
    }
  } catch {
    // Fail closed: if the status read fails, keep the content locked.
    return NextResponse.redirect(paywall)
  }

  return NextResponse.next()
}
