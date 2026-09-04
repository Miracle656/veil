import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Veil — x402 Micropayment Demo',
  description: 'Pay an x402-guarded API with 0.01 XLM, signed by your Veil passkey wallet.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
