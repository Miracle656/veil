'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { USDY_EXPLAINER } from '@/lib/usdy'
import { useInactivityLock } from '@/hooks/useInactivityLock'

export default function UsdyExplainerPage() {
  const router = useRouter()
  useInactivityLock()

  const [acknowledgedRisks, setAcknowledgedRisks] = useState(false)

  return (
    <div className="wallet-shell">
      {/* Navigation */}
      <nav className="wallet-nav">
        <button
          onClick={() => router.back()}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--warm-grey)',
            display: 'flex',
            padding: '0.25rem',
          }}
          aria-label="Back"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path
              d="M19 12H5M12 19l-7-7 7-7"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <span
          style={{
            fontFamily: 'Anton, Impact, sans-serif',
            fontSize: '0.875rem',
            letterSpacing: '0.08em',
            color: 'var(--warm-grey)',
          }}
        >
          ASSET DETAIL · USDY
        </span>
        <div style={{ width: 28 }} />
      </nav>

      <main className="wallet-main" style={{ paddingBottom: '3rem' }}>
        {/* Token Header */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
            padding: '1.25rem 0 1.75rem',
            gap: '10px',
          }}
        >
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, rgba(253,218,36,0.15) 0%, rgba(0,167,181,0.15) 100%)',
              border: '1px solid rgba(253,218,36,0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '1.5rem',
              fontWeight: 700,
              fontFamily: 'Anton, Impact, sans-serif',
              color: 'var(--gold)',
              letterSpacing: '0.05em',
            }}
          >
            $
          </div>

          <div>
            <h1
              style={{
                fontFamily: 'Lora, Georgia, serif',
                fontSize: '1.625rem',
                fontWeight: 600,
                color: 'var(--off-white)',
                marginBottom: '4px',
              }}
            >
              {USDY_EXPLAINER.name}
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
              <span
                style={{
                  fontFamily: 'Inconsolata, monospace',
                  fontSize: '0.8125rem',
                  color: 'var(--gold)',
                  background: 'rgba(253,218,36,0.1)',
                  padding: '2px 8px',
                  borderRadius: '6px',
                  border: '1px solid rgba(253,218,36,0.2)',
                }}
              >
                {USDY_EXPLAINER.code}
              </span>
              <span style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.5)' }}>
                Tokenized Real-World Asset
              </span>
            </div>
          </div>
        </div>

        {/* Section 1: What It Is */}
        <div className="card" style={{ marginBottom: '1.25rem' }}>
          <h2
            style={{
              fontSize: '0.75rem',
              fontFamily: 'Anton, Impact, sans-serif',
              letterSpacing: '0.08em',
              color: 'rgba(246,247,248,0.4)',
              textTransform: 'uppercase',
              marginBottom: '0.5rem',
            }}
          >
            What is USDY?
          </h2>
          <p style={{ fontSize: '0.9375rem', lineHeight: 1.55, color: 'var(--off-white)', marginBottom: '0.75rem' }}>
            {USDY_EXPLAINER.whatItIs}
          </p>
          <div
            style={{
              padding: '0.75rem',
              background: 'rgba(255,255,255,0.03)',
              borderRadius: '8px',
              border: '1px solid var(--border-dim)',
              fontSize: '0.8125rem',
              color: 'rgba(246,247,248,0.7)',
            }}
          >
            <strong style={{ color: 'var(--teal)' }}>Backing:</strong> {USDY_EXPLAINER.backedBy}
          </div>
        </div>

        {/* Section 2: Who Issues It (Issuer & Disclosures Link) */}
        <div className="card" style={{ marginBottom: '1.25rem' }}>
          <h2
            style={{
              fontSize: '0.75rem',
              fontFamily: 'Anton, Impact, sans-serif',
              letterSpacing: '0.08em',
              color: 'rgba(246,247,248,0.4)',
              textTransform: 'uppercase',
              marginBottom: '0.5rem',
            }}
          >
            Issuer & Disclosures
          </h2>
          <p style={{ fontSize: '0.875rem', color: 'var(--off-white)', marginBottom: '0.5rem' }}>
            Issued by <strong style={{ color: 'var(--gold)' }}>{USDY_EXPLAINER.issuerName}</strong>
          </p>
          <p
            style={{
              fontSize: '0.75rem',
              fontFamily: 'Inconsolata, monospace',
              color: 'rgba(246,247,248,0.45)',
              wordBreak: 'break-all',
              marginBottom: '0.875rem',
            }}
          >
            Issuer Address: {USDY_EXPLAINER.issuerAddress}
          </p>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            <a
              href={USDY_EXPLAINER.disclosuresUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary"
              style={{
                fontSize: '0.8125rem',
                padding: '6px 14px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                textDecoration: 'none',
              }}
            >
              <span>Official Disclosures ({USDY_EXPLAINER.homeDomain})</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
              </svg>
            </a>
            <a
              href={USDY_EXPLAINER.prospectusUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary"
              style={{
                fontSize: '0.8125rem',
                padding: '6px 14px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                textDecoration: 'none',
              }}
            >
              <span>Prospectus & Filings</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
              </svg>
            </a>
          </div>
        </div>

        {/* Section 3: How Value Accrues */}
        <div className="card" style={{ marginBottom: '1.25rem' }}>
          <h2
            style={{
              fontSize: '0.75rem',
              fontFamily: 'Anton, Impact, sans-serif',
              letterSpacing: '0.08em',
              color: 'rgba(246,247,248,0.4)',
              textTransform: 'uppercase',
              marginBottom: '0.5rem',
            }}
          >
            How Value Accrues
          </h2>
          <p style={{ fontSize: '0.9375rem', lineHeight: 1.55, color: 'var(--off-white)' }}>
            {USDY_EXPLAINER.howValueAccrues}
          </p>
        </div>

        {/* Section 4: Key Risks & Disclaimers (Must be visible before action) */}
        <div
          className="card"
          style={{
            marginBottom: '1.5rem',
            border: '1px solid rgba(255, 107, 107, 0.25)',
            background: 'rgba(255, 107, 107, 0.03)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '0.75rem' }}>
            <span style={{ color: '#FF6B6B', fontSize: '1rem' }}>⚠</span>
            <h2
              style={{
                fontSize: '0.75rem',
                fontFamily: 'Anton, Impact, sans-serif',
                letterSpacing: '0.08em',
                color: '#FF6B6B',
                textTransform: 'uppercase',
                margin: 0,
              }}
            >
              Key Risks (What Can Go Wrong)
            </h2>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {USDY_EXPLAINER.risks.map((risk) => (
              <div
                key={risk.id}
                style={{
                  padding: '10px 12px',
                  background: 'rgba(0,0,0,0.2)',
                  borderRadius: '8px',
                  border: '1px solid rgba(255, 255, 255, 0.06)',
                }}
              >
                <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--off-white)', marginBottom: '3px' }}>
                  {risk.title}
                </div>
                <div style={{ fontSize: '0.8125rem', lineHeight: 1.5, color: 'rgba(246,247,248,0.7)' }}>
                  {risk.description}
                </div>
              </div>
            ))}
          </div>

          <div
            style={{
              marginTop: '1rem',
              paddingTop: '0.875rem',
              borderTop: '1px solid rgba(255,255,255,0.06)',
              fontSize: '0.75rem',
              color: 'rgba(246,247,248,0.4)',
              lineHeight: 1.4,
            }}
          >
            {USDY_EXPLAINER.importantNotices.map((notice, idx) => (
              <p key={idx} style={{ margin: '3px 0' }}>
                • {notice}
              </p>
            ))}
          </div>
        </div>

        {/* Section 5: User Acknowledgement & Action Button */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '10px',
              cursor: 'pointer',
              fontSize: '0.8125rem',
              color: 'rgba(246,247,248,0.75)',
              lineHeight: 1.4,
            }}
          >
            <input
              type="checkbox"
              checked={acknowledgedRisks}
              onChange={(e) => setAcknowledgedRisks(e.target.checked)}
              style={{ marginTop: '2px', cursor: 'pointer', accentColor: 'var(--gold)' }}
            />
            <span>I have read the disclosures, understand how USDY functions, and acknowledge the associated risks.</span>
          </label>

          <Link
            href={
              acknowledgedRisks
                ? `/swap?to=USDY&issuer=${USDY_EXPLAINER.issuerAddress}`
                : '#'
            }
            className={`btn btn-primary ${!acknowledgedRisks ? 'disabled' : ''}`}
            style={{
              width: '100%',
              textAlign: 'center',
              display: 'block',
              padding: '0.875rem',
              opacity: acknowledgedRisks ? 1 : 0.45,
              pointerEvents: acknowledgedRisks ? 'auto' : 'none',
              cursor: acknowledgedRisks ? 'pointer' : 'not-allowed',
            }}
          >
            Swap / Buy USDY on DEX
          </Link>

          <button
            onClick={() => router.back()}
            className="btn btn-secondary"
            style={{ width: '100%', padding: '0.75rem', textAlign: 'center' }}
          >
            Return to Wallet
          </button>
        </div>
      </main>
    </div>
  )
}
