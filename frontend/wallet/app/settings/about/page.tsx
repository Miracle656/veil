'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { PageHeader, Card, Label } from '@/components/ui/primitives'
import { walletSession } from '@/lib/walletStorage'
import {
  getBuildId,
  getNetworkFacts,
  getContractEntries,
  explorerAddressUrl,
  shortAddress,
  EXTERNAL_LINKS,
} from '@/lib/about'

export default function AboutPage() {
  const router = useRouter()
  const [mounted, setMounted] = useState(false)
  const [walletAddress, setWalletAddress] = useState<string | null>(null)

  useEffect(() => {
    setMounted(true)
    setWalletAddress(walletSession.getItem('invisible_wallet_address'))
  }, [])

  // The active network comes from localStorage, which the server cannot see, and
  // mainnet's RPC URL resolves off `window.location.origin` — so rendering these
  // facts before mount would emit different server and client HTML (and show a
  // blank RPC row during SSR). Same reason `NetworkSwitcher` gates on mount.
  const networkFacts = mounted ? getNetworkFacts() : []
  const contractEntries = mounted ? getContractEntries(walletAddress) : []

  return (
    <div className="wallet-shell" style={{ padding: '1.5rem 1.25rem 4rem' }}>
      <div style={{ maxWidth: 480, width: '100%', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.75rem' }}>
          <button
            type="button"
            onClick={() => router.push('/settings')}
            aria-label="Back to settings"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--off-white)', display: 'flex', padding: 0 }}
          >
            <ChevronLeft size={22} strokeWidth={1.75} />
          </button>
          <PageHeader eyebrow="Veil" title="About" />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <Card>
            <Label>Build</Label>
            <p style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.875rem', marginTop: '0.5rem', color: 'var(--off-white)' }}>
              {getBuildId()}
            </p>
          </Card>

          <div>
            <Label className="mb-2 block">Network</Label>
            <Card padded={false}>
              {networkFacts.map((fact, i) => (
                <div
                  key={fact.key}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '0.875rem 1.25rem',
                    borderBottom: i === networkFacts.length - 1 ? 'none' : '1px solid rgba(255,255,255,0.06)',
                  }}
                >
                  <span style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.6)' }}>{fact.label}</span>
                  <span style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.8125rem', color: 'var(--off-white)' }}>
                    {fact.value}
                  </span>
                </div>
              ))}
            </Card>
          </div>

          <div>
            <Label className="mb-2 block">Contracts</Label>
            <Card padded={false}>
              {contractEntries.map((entry, i) => {
                const url = explorerAddressUrl(entry.value)
                const content = (
                  <>
                    <span style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.6)' }}>{entry.label}</span>
                    <span style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.8125rem', color: 'var(--gold)' }}>
                      {shortAddress(entry.value)}
                    </span>
                  </>
                )
                const rowStyle = {
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '0.875rem 1.25rem',
                  borderBottom: i === contractEntries.length - 1 ? 'none' : '1px solid rgba(255,255,255,0.06)',
                } as const
                return url ? (
                  <a key={entry.key} href={url} target="_blank" rel="noreferrer" style={{ ...rowStyle, textDecoration: 'none' }}>
                    {content}
                  </a>
                ) : (
                  <div key={entry.key} style={rowStyle}>{content}</div>
                )
              })}
            </Card>
          </div>

          <div>
            <Label className="mb-2 block">Help &amp; links</Label>
            <Card padded={false}>
              {EXTERNAL_LINKS.map((link, i) => (
                <a
                  key={link.key}
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '0.875rem 1.25rem',
                    borderBottom: i === EXTERNAL_LINKS.length - 1 ? 'none' : '1px solid rgba(255,255,255,0.06)',
                    textDecoration: 'none',
                  }}
                >
                  <div>
                    <p style={{ fontSize: '0.875rem', color: 'var(--off-white)' }}>{link.label}</p>
                    <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.125rem' }}>{link.description}</p>
                  </div>
                </a>
              ))}
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
