import type { Metadata, Viewport } from 'next'
import { Lora, Inter, Inconsolata, Anton } from 'next/font/google'
import './globals.css'

// Loaded here rather than via an @import in globals.css: the production CSS
// bundle drops that @import, so the deployed wallet rendered every face in a
// fallback (Lora became Georgia, which reads noticeably wider and heavier).
// next/font self-hosts the files and emits @font-face into the build.
const lora = Lora({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-lora',
})
const inter = Inter({ subsets: ['latin'], display: 'swap', variable: '--font-inter' })
const inconsolata = Inconsolata({ subsets: ['latin'], display: 'swap', variable: '--font-inconsolata' })
// Anton is single-weight and not variable, so the weight has to be named.
const anton = Anton({ weight: '400', subsets: ['latin'], display: 'swap', variable: '--font-anton' })

const fontVars = [lora.variable, inter.variable, inconsolata.variable, anton.variable].join(' ')
import { InstallBanner } from './InstallBanner'
import { SentryInit } from './SentryInit'

export const metadata: Metadata = {
  // Absolute URLs for og:image and friends. Never derived from the deployment:
  // that is how the marketing site ended up with canonicals pointing at a
  // login-protected, noindex preview URL.
  metadataBase: new URL('https://app.useveilapp.xyz'),
  title: 'Veil Wallet',
  description: 'Your passkey-powered Stellar wallet. No seed phrases. No private keys. Just your fingerprint.',
  keywords: ['Stellar', 'Soroban', 'WebAuthn', 'passkey', 'wallet', 'biometric'],
  manifest: '/manifest.json',
  openGraph: {
    title: 'Veil Wallet',
    description: 'Passkey-powered Stellar smart wallet.',
    type: 'website',
    url: '/',
    siteName: 'Veil',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Veil — a passkey smart wallet on Stellar.' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Veil Wallet',
    description: 'Passkey-powered Stellar smart wallet. No seed phrases. No private keys.',
    images: ['/og.png'],
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0F0F0F',
}
  

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={fontVars} suppressHydrationWarning>
      {/* Inline script runs before first paint to apply stored theme and prevent flash */}
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var t=localStorage.getItem('veil_theme');document.documentElement.setAttribute('data-theme',t==='light'?'light':'dark');})();`,
          }}
        />
      </head>
      <body>
        {children}
        <InstallBanner />
        <SentryInit />
      </body>
    </html>
  )
}
