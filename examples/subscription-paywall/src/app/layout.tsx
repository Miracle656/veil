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
      <body className="min-h-screen bg-gray-950 text-gray-100 antialiased">{children}</body>
    </html>
  )
}
