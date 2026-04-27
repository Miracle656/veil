import type { Metadata, Viewport } from 'next'
import './globals.css'
import { InstallBanner } from './InstallBanner'

export const metadata: Metadata = {
  title: 'Veil Wallet',
  description: 'Your passkey-powered Stellar wallet. No seed phrases. No private keys. Just your fingerprint.',
  keywords: ['Stellar', 'Soroban', 'WebAuthn', 'passkey', 'wallet', 'biometric'],
  manifest: '/manifest.json',
  openGraph: {
    title: 'Veil Wallet',
    description: 'Passkey-powered Stellar smart wallet.',
    type: 'website',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#0F0F0F',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
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
      </body>
    </html>
  )
}
