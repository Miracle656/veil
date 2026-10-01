'use client'

/**
 * dApp directory — web parity for discovery (#813).
 *
 * The desktop wallet cannot embed a WebView the way mobile can, and should not
 * try: a browser inside a browser adds a signing surface with none of the
 * isolation. Parity here means discovery, not embedding. Every entry comes
 * from the ONE allow-list module both apps read — mobile's
 * `lib/dappAllowlist.ts` (imported as `@veil/dapps`) — and opens in a NEW TAB.
 * Connecting happens through the existing WalletConnect flow, mounted below.
 *
 * The search matches name and category, exactly like the mobile directory
 * screen, and a query with no matches shows an empty state rather than a blank
 * screen.
 */

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ExternalLink } from 'lucide-react'

import { ConnectDAppModal } from '@/components/ConnectDAppModal'
import { VeilMark } from '@/components/ui/VeilMark'
import { Card, Glyph, Mono, PageHeader, SectionLabel } from '@/components/ui/primitives'
import { openDappInNewTab } from '@/lib/dapps'
import { filterDapps, type DappEntry } from '@veil/dapps'

export default function DappsPage() {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [showConnect, setShowConnect] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const results = useMemo(() => filterDapps(query), [query])
  const isEmpty = results.length === 0

  const handleOpen = (entry: DappEntry) => {
    if (!openDappInNewTab(entry.origin)) {
      setError(
        `Could not open ${entry.name} — your browser blocked the new tab. Allow pop-ups for this site, or copy ${entry.origin} into a new tab yourself.`,
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
            from the curated allow-list shared with the mobile app. When one
            asks to connect, approve it here through WalletConnect — the
            wallet, not the page, does the signing.
          </p>
        </Card>

        {/* Search — matches name and category, like the mobile directory. */}
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or category"
          aria-label="Search dApps"
          style={{
            marginTop: '1.5rem',
            width: '100%',
            maxWidth: 420,
            padding: '0.625rem 0.875rem',
            borderRadius: 8,
            border: '1px solid rgba(246,247,248,0.16)',
            background: 'rgba(246,247,248,0.04)',
            color: 'var(--off-white)',
            fontSize: '0.875rem',
            outline: 'none',
          }}
        />

        <p style={{ marginTop: '1rem', fontSize: '0.75rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(246,247,248,0.45)' }}>
          {isEmpty ? 'No matches' : `${results.length} ${results.length === 1 ? 'dApp' : 'dApps'}`}
        </p>

        {isEmpty ? (
          <Card className="mt-4 text-center">
            <p style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontSize: '1.0625rem', color: 'var(--off-white)' }}>
              No dApps match &ldquo;{query.trim()}&rdquo;
            </p>
            <p style={{ marginTop: '0.5rem', fontSize: '0.8125rem', lineHeight: 1.6, color: 'rgba(246,247,248,0.6)' }}>
              Try a category like Swap, Trade or Learn — or clear the search to
              see everything Veil supports.
            </p>
            <button
              className="btn-ghost"
              style={{ marginTop: '1rem', fontSize: '0.8125rem' }}
              onClick={() => setQuery('')}
            >
              Clear search
            </button>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2" style={{ marginTop: '0.75rem' }}>
            {results.map((dapp) => (
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

                <div className="flex items-center justify-between gap-3">
                  <span style={{ fontSize: '0.6875rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(246,247,248,0.4)' }}>
                    {dapp.category}
                  </span>
                  <button
                    className="btn-ghost"
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', fontSize: '0.8125rem' }}
                    onClick={() => handleOpen(dapp)}
                  >
                    <ExternalLink size={15} strokeWidth={1.5} aria-hidden="true" />
                    Open in new tab
                  </button>
                </div>
              </Card>
            ))}
          </div>
        )}

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
