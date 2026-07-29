import type { Metadata } from 'next'
import './globals.css'

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'Veil — Passkey-Powered Stellar Wallets',
  description:
    'A seedless, biometric-native smart wallet built on Stellar Soroban. No seed phrases. No private keys. Just your fingerprint.',
  keywords: ['Stellar', 'Soroban', 'WebAuthn', 'passkey', 'smart wallet', 'crypto', 'biometric'],
  openGraph: {
    title: 'Veil — Passkey-Powered Stellar Wallets',
    description: 'Your biometric IS your key. Seedless smart accounts on Stellar Soroban.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Veil — Passkey-Powered Stellar Wallets',
    description: 'No seed phrases. No private keys. Just your fingerprint.',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
