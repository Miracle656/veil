'use client'

import { useEffect, useState, type CSSProperties } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'

import { useInactivityLock } from '@/hooks/useInactivityLock'
import { getRegisteredAsset } from '@/lib/assets'
import { buildBondExplainer, isSovereignDebt, type BondExplainer } from '@/lib/bondExplainer'
import { loadRegisteredIssuerMetadata, type IssuerTomlMetadata } from '@/lib/issuerToml'
import { fetchPrice } from '@/lib/fetchPrice'
/**
 * One screen that explains what a Stablebond is (#1060).
 *
 * Reachable from the asset row (`/assets`) and from the buy flow (`/buy`). The
 * content is built from the registry and the issuer's own stellar.toml — none
 * of it is written per asset here. When the TOML is missing or unreachable the
 * screen still renders, using only the registry facts and saying so.
 */
export default function BondExplainerPage() {
  const router = useRouter()
  useInactivityLock()

  const params = useParams()
  const code = typeof params.code === 'string' ? params.code.toUpperCase() : ''

  const asset = getRegisteredAsset(code)
  const registered = !!asset && asset.code === code && isSovereignDebt(asset)

  const [meta, setMeta] = useState<IssuerTomlMetadata | null>(null)
  const [price, setPrice] = useState<number | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)

  useEffect(() => {
    if (!asset || !registered) return
    let cancelled = false

    void (async () => {
      const [fetchedMeta, fetchedPrice] = await Promise.all([
        loadRegisteredIssuerMetadata(asset.code, asset.issuer),
        fetchPrice(asset.code, asset.issuer),
      ])
      if (cancelled) return
      setMeta(fetchedMeta)
      setPrice(fetchedPrice)
    })()

    return () => {
      cancelled = true
    }
  }, [asset, registered])

  if (!asset || !registered) {
    return (
      <div className="wallet-shell">
        <nav className="wallet-nav">
          <button onClick={() => router.back()} style={backButtonStyle}>
            <ChevronLeft /> Back
          </button>
          <span style={navTitleStyle}>ASSET DETAIL</span>
          <div style={{ width: 28 }} />
        </nav>
        <main className="wallet-main">
          <div className="card" style={{ padding: '1.25rem' }}>
            <p style={{ color: 'var(--off-white)', fontSize: '0.9375rem' }}>
              No registered sovereign-debt asset has the code {code || '—'}.
            </p>
          </div>
        </main>
      </div>
    )
  }

  const explainer: BondExplainer = buildBondExplainer(asset, meta)
  const canBuy = acknowledged
  const buyHref = `/swap?to=${encodeURIComponent(asset.code)}&issuer=${asset.issuer}`

  return (
    <div className="wallet-shell">
      <nav className="wallet-nav">
        <button onClick={() => router.back()} style={backButtonStyle}>
          <ChevronLeft /> Back
        </button>
        <span style={navTitleStyle}>ASSET DETAIL · {asset.code}</span>
        <div style={{ width: 28 }} />
      </nav>

      <main className="wallet-main" style={{ paddingBottom: '3rem' }}>
        {/* Header */}
        <div style={headerRowStyle}>
          <BondMark code={asset.code} imageUrl={meta?.imageUrl ?? null} />
          <div style={{ minWidth: 0 }}>
            <h1 style={headingStyle}>{explainer.name}</h1>
            <p style={{ color: 'rgba(246,247,248,0.5)', fontSize: '0.8125rem' }}>
              Tokenized sovereign debt · {asset.code}
            </p>
          </div>
        </div>

        {/* What it is */}
        <Section label={`What is ${asset.code}?`}>
          <p style={bodyTextStyle}>{explainer.whatItIs}</p>
          {explainer.description ? (
            <p style={issuerQuoteStyle}>
              <span style={{ color: 'var(--warm-grey)' }}>From {explainer.issuerName}&apos;s own stellar.toml: </span>
              {explainer.description}
            </p>
          ) : (
            <p style={{ ...issuerQuoteStyle, color: 'var(--warm-grey)' }}>
              {explainer.issuerName}&apos;s stellar.toml could not be read, so the issuer&apos;s own description and
              stated backing are not shown here.
            </p>
          )}
        </Section>

        {/* Who issues it */}
        <Section label="Who issues it">
          <p style={bodyTextStyle}>{explainer.whoIssuesIt}</p>
          <p style={monoTextStyle}>Issuer address: {asset.issuer}</p>
          {explainer.issuerSiteUrl ? (
            <a href={explainer.issuerSiteUrl} target="_blank" rel="noopener noreferrer" style={linkButtonStyle}>
              {explainer.issuerName} disclosures ({explainer.homeDomain}) ↗
            </a>
          ) : null}
        </Section>

        {/* How the price works */}
        <Section label="How the price works">
          <p style={bodyTextStyle}>{explainer.howThePriceWorks}</p>
          <div style={priceBoxStyle}>
            <span style={{ color: 'var(--warm-grey)', fontSize: '0.8125rem' }}>Market price</span>
            <span style={{ fontFamily: 'Inconsolata, monospace', color: 'var(--off-white)', fontWeight: 600 }}>
              {price != null ? `${price.toFixed(4)} USDC per ${asset.code}` : 'Unavailable right now'}
            </span>
          </div>
        </Section>

        {/* Veil's role */}
        <Section label="Veil's role">
          <p style={bodyTextStyle}>{explainer.veilsRole}</p>
        </Section>

        {/* Acknowledgement + buy */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '0.5rem' }}>
          <label style={ackLabelStyle}>
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              style={{ marginTop: '2px', cursor: 'pointer', accentColor: 'var(--gold)' }}
            />
            <span>
              I have read who issues this token and whose debt it represents, and I understand its price moves and
              that Veil is not the counterparty.
            </span>
          </label>

          {canBuy ? (
            <Link href={buyHref} className="btn-gold" style={buyButtonStyle}>
              Buy {asset.code}
            </Link>
          ) : (
            <span className="btn-gold" style={{ ...buyButtonStyle, opacity: 0.45, pointerEvents: 'none' }}>
              Buy {asset.code}
            </span>
          )}

          <button onClick={() => router.back()} className="btn-ghost" style={secondaryButtonStyle}>
            Return
          </button>
        </div>
      </main>
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="card" style={{ marginBottom: '1.25rem', padding: '1.125rem 1.25rem' }}>
      <h2 style={sectionLabelStyle}>{label}</h2>
      {children}
    </section>
  )
}

function BondMark({ code, imageUrl }: { code: string; imageUrl: string | null }) {
  const [broken, setBroken] = useState<string | null>(null)
  if (imageUrl && imageUrl !== broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt=""
        width={48}
        height={48}
        onError={() => setBroken(imageUrl)}
        style={{ width: 48, height: 48, borderRadius: 12, objectFit: 'cover', flexShrink: 0 }}
      />
    )
  }
  return (
    <span aria-hidden="true" style={markFallbackStyle}>
      {code[0] ?? '?'}
    </span>
  )
}

function ChevronLeft() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

const backButtonStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  color: 'var(--off-white)',
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  fontSize: '0.875rem',
}

const navTitleStyle: CSSProperties = {
  fontSize: '0.75rem',
  fontFamily: 'Anton, Impact, sans-serif',
  letterSpacing: '0.08em',
  color: 'var(--warm-grey)',
}

const headerRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.875rem',
  padding: '0.5rem 0 1.5rem',
}

const headingStyle: CSSProperties = {
  fontFamily: 'Lora, Georgia, serif',
  fontWeight: 600,
  fontStyle: 'italic',
  fontSize: '1.5rem',
  lineHeight: 1.15,
  color: 'var(--off-white)',
  marginBottom: '0.125rem',
}

const markFallbackStyle: CSSProperties = {
  width: 48,
  height: 48,
  borderRadius: 12,
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(253,218,36,0.12)',
  border: '1px solid rgba(253,218,36,0.25)',
  color: 'var(--gold)',
  fontWeight: 700,
  fontFamily: 'Anton, Impact, sans-serif',
  fontSize: '1.25rem',
}

const sectionLabelStyle: CSSProperties = {
  fontSize: '0.72rem',
  fontFamily: 'Anton, Impact, sans-serif',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'rgba(246,247,248,0.4)',
  marginBottom: '0.5rem',
}

const bodyTextStyle: CSSProperties = {
  fontSize: '0.9375rem',
  lineHeight: 1.55,
  color: 'var(--off-white)',
}

const issuerQuoteStyle: CSSProperties = {
  marginTop: '0.75rem',
  padding: '0.75rem',
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid var(--border-dim)',
  borderRadius: '8px',
  fontSize: '0.8125rem',
  lineHeight: 1.5,
  color: 'rgba(246,247,248,0.8)',
}

const monoTextStyle: CSSProperties = {
  marginTop: '0.625rem',
  fontFamily: 'Inconsolata, monospace',
  fontSize: '0.75rem',
  color: 'rgba(246,247,248,0.45)',
  wordBreak: 'break-all',
}

const priceBoxStyle: CSSProperties = {
  marginTop: '0.75rem',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.5rem',
  padding: '0.625rem 0.75rem',
  background: 'rgba(0,0,0,0.2)',
  border: '1px solid var(--border-dim)',
  borderRadius: '8px',
}

const linkButtonStyle: CSSProperties = {
  display: 'inline-block',
  marginTop: '0.75rem',
  padding: '6px 14px',
  fontSize: '0.8125rem',
  borderRadius: '8px',
  border: '1px solid var(--border-dim)',
  background: 'rgba(255,255,255,0.05)',
  color: 'var(--gold)',
  textDecoration: 'none',
}

const ackLabelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: '10px',
  cursor: 'pointer',
  fontSize: '0.8125rem',
  color: 'rgba(246,247,248,0.75)',
  lineHeight: 1.4,
}

const buyButtonStyle: CSSProperties = {
  width: '100%',
  textAlign: 'center',
  padding: '0.875rem',
  textDecoration: 'none',
  display: 'block',
}

const secondaryButtonStyle: CSSProperties = {
  width: '100%',
  padding: '0.75rem',
  textAlign: 'center',
}
