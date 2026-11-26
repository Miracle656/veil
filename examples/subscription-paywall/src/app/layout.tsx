import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Veil — Subscription Paywall',
  description:
    'Recurring on-chain subscription paywall with passkey auth, built on invisible-wallet-sdk',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-950 text-gray-100 antialiased">
        <div className="bg-amber-950/80 border-b border-amber-500/40 px-4 py-2.5 text-center text-xs sm:text-sm text-amber-200">
          <span className="font-semibold text-amber-400">⚠️ Demonstration only — not production-safe:</span>{' '}
          Access is gated by an unauthenticated cookie naming a subscriber wallet. Anyone setting this cookie gains access without proving wallet ownership. Production apps must require cryptographic session authentication.
        </div>
        {children}
      </body>
    </html>
  )
}
