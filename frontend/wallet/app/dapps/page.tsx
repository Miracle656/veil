'use client'

/**
 * dApp directory — web parity for discovery (#813).
 *
 * The desktop wallet cannot embed a WebView the way mobile can, and should not
 * try: a browser inside a browser adds a signing surface with none of the
 * isolation. Parity here means discovery, not embedding. Every entry comes
 * from the shared allow-list (`frontend/shared/dapps.ts`) — the same module
 * the mobile app renders — and opens in a NEW TAB. Connecting happens through
 * the existing WalletConnect flow, mounted below.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ExternalLink } from 'lucide-react'

import { ConnectDAppModal } from '@/components/ConnectDAppModal'
import { VeilMark } from '@/components/ui/VeilMark'
import { Card, Glyph, Mono, PageHeader, SectionLabel } from '@/components/ui/primitives'
import { openDappInNewTab } from '@/lib/dapps'
import { DAPP_DIRECTORY } from '../../../shared/dapps'

export default function DappsPage() {
  const router = useRouter()
  const [showConnect, setShowConnect] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleOpen = (origin: string, name: string) => {
    if (!openDappInNewTab(origin)) {
      setError(
        `Could not open ${name} — your browser blocked the new tab. Allow pop-ups for this site, or copy ${origin} into a new tab yourself.`,
      )
      return
    }
    setError(null)
  }

  return (
    <div className="wallet-shell">
      {/* Nav */}
      <nav className="wallet-nav">
        <button
          onClick={() => router.back()}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--off-white)', display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.875rem' }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Back
        </button>
        <VeilMark size={22} />
        <div style={{ width: 40 }} />
      </nav>

      <main className="wallet-main">
        <PageHeader
          eyebrow="Discover"
          title="dApps"
          action={
            <button
              className="btn-gold"
              style={{ width: 'auto', padding: '0.5rem 1rem', fontSize: '0.8125rem' }}
              onClick={() => setShowConnect(true)}
            >
              Connect dApp
            </button>
          }
        />

        <Card className="mt-5">
          <SectionLabel>Discovery, not embedding</SectionLabel>
          <p style={{ marginTop: '0.625rem', fontSize: '0.875rem', lineHeight: 1.6, color: 'rgba(246,247,248,0.72)' }}>
            Veil never hosts a browser inside the wallet — that would put a
            signing surface inside a signing surface with none of the isolation.
            Every dApp below opens in <strong style={{ color: 'var(--off-white)' }}>its own browser tab</strong>,
            from a curated allow-list shared with the mobile app. When one asks
            to connect, approve it here through WalletConnect — the wallet, not
            the page, does the signing.
          </p>
        </Card>

        <div className="grid gap-4 sm:grid-cols-2" style={{ marginTop: '1.5rem' }}>
          {DAPP_DIRECTORY.map((dapp) => (
            <Card key={dapp.id} className="flex flex-col gap-3.5">
              <div className="flex items-center gap-3">
                <Glyph tone="gold">{dapp.name.slice(0, 1)}</Glyph>
                <div className="min-w-0">
                  <div style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.0625rem', color: 'var(--off-white)' }}>
                    {dapp.name}
                  </div>
                  <Mono>{dapp.origin}</Mono>
                </div>
              </div>

              <p style={{ fontSize: '0.8125rem', lineHeight: 1.55, color: 'rgba(246,247,248,0.6)', flex: 1 }}>
                {dapp.description}
              </p>

              <button
                className="btn-ghost"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', fontSize: '0.8125rem' }}
                onClick={() => handleOpen(dapp.origin, dapp.name)}
              >
                <ExternalLink size={15} strokeWidth={1.5} aria-hidden="true" />
                Open in new tab
              </button>
            </Card>
          ))}
        </div>

        {error && (
          <p style={{ marginTop: '1rem', fontSize: '0.8125rem', color: 'var(--teal)' }}>{error}</p>
        )}

        <p style={{ marginTop: '1.5rem', fontSize: '0.75rem', lineHeight: 1.6, color: 'rgba(246,247,248,0.4)' }}>
          The directory is curated — every origin is vetted before it lands here.
          Prefer not to open anything? Use <strong style={{ color: 'rgba(246,247,248,0.6)' }}>Connect dApp</strong> to
          pair with a WalletConnect QR code or URI directly.
        </p>

        <ConnectDAppModal
          isOpen={showConnect}
          onClose={() => setShowConnect(false)}
        />
      </main>
    </div>
  )
}
