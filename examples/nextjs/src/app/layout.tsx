import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Veil Wallet — Next.js Starter',
  description: 'Passkey-powered Stellar wallet using invisible-wallet-sdk',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-950 text-gray-100 antialiased">
        {children}
      </body>
    </html>
  )
}
