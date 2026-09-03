import type { Metadata } from 'next'
import { Lora, Inter, Inconsolata, Anton } from 'next/font/google'
import './globals.css'

// These used to come from an @import at the top of globals.css. That works in
// dev but the production CSS bundle drops it, so the deployed site rendered
// every face in a fallback — Lora fell back to Georgia, which is why headings
// looked wide and heavy. next/font self-hosts the files and emits real
// @font-face rules into the build, so there is nothing left to strip.
const lora = Lora({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-lora',
})
const inter = Inter({ subsets: ['latin'], display: 'swap', variable: '--font-inter' })
const inconsolata = Inconsolata({ subsets: ['latin'], display: 'swap', variable: '--font-inconsolata' })
// Anton ships a single weight and is not a variable font, so it needs one named.
const anton = Anton({ weight: '400', subsets: ['latin'], display: 'swap', variable: '--font-anton' })

const fontVars = [lora.variable, inter.variable, inconsolata.variable, anton.variable].join(' ')

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
    <html lang="en" className={fontVars}>
      <body>{children}</body>
    </html>
  )
}
