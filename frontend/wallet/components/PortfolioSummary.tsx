'use client'

/**
 * Portfolio summary card (issue #740).
 *
 * Displays the wallet's holdings across cash, lending, and invest assets.
 * Each line shows the asset, its value in the user's chosen currency, and its
 * share of the total as a bar and percentage. The "priced at" timestamp and
 * unavailable-price handling follow the same design rules as the rest of the
 * wallet: an em dash for unpriced lines, never a false zero.
 */

import type { PortfolioSummary as Summary, PortfolioLine } from '@/lib/portfolio'
import { Amount, Label, Row, TokenIcon } from '@/components/ui/primitives'
import { formatFiat, type CurrencyCode } from '@/lib/currency'

// ── Section header ────────────────────────────────────────────────────────────

function SectionHeader({ label, valueUsd, currencyCode, fxRate }: {
  label: string
  valueUsd: number | null
  currencyCode: CurrencyCode
  fxRate: number
}) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '14px 0 4px',
    }}>
      <span style={{
        fontSize: '11px',
        fontWeight: 700,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: 'rgba(246,247,248,0.45)',
      }}>
        {label}
      </span>
      <Amount className="text-[13px] font-semibold text-[rgba(246,247,248,0.55)]">
        {valueUsd !== null ? formatFiat(valueUsd, currencyCode, fxRate) : '—'}
      </Amount>
    </div>
  )
}

// ── Share bar ─────────────────────────────────────────────────────────────────

function ShareBar({ share }: { share: number | null }) {
  if (share === null) return null
  const pct = Math.max(0, Math.min(1, share)) * 100

  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      title={`${pct.toFixed(1)}% of total`}
      style={{
        height: '3px',
        background: 'rgba(255,255,255,0.08)',
        borderRadius: '2px',
        overflow: 'hidden',
        marginTop: '4px',
      }}
    >
      <div
        style={{
          height: '100%',
          width: `${pct}%`,
          background: 'var(--gold)',
          borderRadius: '2px',
          transition: 'width 0.4s ease',
        }}
      />
    </div>
  )
}

// ── Asset line ────────────────────────────────────────────────────────────────

function AssetLine({
  line,
  hideAmounts,
  currencyCode,
  fxRate,
  last,
}: {
  line: PortfolioLine
  hideAmounts: boolean
  currencyCode: CurrencyCode
  fxRate: number
  last: boolean
}) {
  const fiatLabel = line.valueUsd !== null
    ? formatFiat(line.valueUsd, currencyCode, fxRate)
    : '—'

  const shareLabel = line.share !== null
    ? `${(line.share * 100).toFixed(1)}%`
    : null

  return (
    <div style={{ paddingBottom: last ? 0 : undefined }}>
      <Row last={last} className="vw-listrow">
        <span style={{ display: 'flex', alignItems: 'center', gap: '14px', minWidth: 0 }}>
          <TokenIcon code={line.code} size={36} />
          <span style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
            <span style={{ fontSize: '15px', fontWeight: 600 }}>{line.code}</span>
            <span className="vw-meta">
              {hideAmounts
                ? '••••'
                : `${parseFloat(line.amount).toFixed(4)} ${line.code}`}
            </span>
          </span>
        </span>
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px', flexShrink: 0 }}>
          <Amount className="text-[15px] font-semibold">
            {hideAmounts ? '••••' : fiatLabel}
          </Amount>
          {!hideAmounts && shareLabel && (
            <span style={{ fontSize: '11px', color: 'rgba(246,247,248,0.4)' }}>
              {shareLabel}
            </span>
          )}
        </span>
      </Row>
      {!hideAmounts && <ShareBar share={line.share} />}
    </div>
  )
}

// ── Bucket section ────────────────────────────────────────────────────────────

function Bucket({
  label,
  lines,
  bucketUsd,
  hideAmounts,
  currencyCode,
  fxRate,
}: {
  label: string
  lines: PortfolioLine[]
  bucketUsd: number | null
  hideAmounts: boolean
  currencyCode: CurrencyCode
  fxRate: number
}) {
  if (lines.length === 0) return null
  return (
    <section aria-label={label}>
      <SectionHeader
        label={label}
        valueUsd={bucketUsd}
        currencyCode={currencyCode}
        fxRate={fxRate}
      />
      {lines.map((line, i) => (
        <AssetLine
          key={line.code + '-' + (line.issuer ?? 'native')}
          line={line}
          hideAmounts={hideAmounts}
          currencyCode={currencyCode}
          fxRate={fxRate}
          last={i === lines.length - 1}
        />
      ))}
    </section>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export interface PortfolioSummaryProps {
  /** The computed portfolio (from buildPortfolio). */
  portfolio: Summary
  /** User's chosen display currency. */
  currencyCode: CurrencyCode
  /** USD→local FX rate for the chosen currency. */
  fxRate: number
  /** Mask all amounts behind ••••. */
  hideAmounts?: boolean
}

/**
 * Portfolio summary card.
 *
 * Renders a bucketed view of what the user holds: cash (XLM, USDC, stables),
 * lending (Blend supply positions), and invest (yield-bearing tokens). Each
 * line shows its share of the portfolio total via an inline bar.
 *
 * Unpriced lines show an em dash rather than zero, so a Lens outage reads as
 * "price unavailable" rather than "you have nothing here".
 */
export function PortfolioSummary({
  portfolio,
  currencyCode,
  fxRate,
  hideAmounts = false,
}: PortfolioSummaryProps) {
  const { lines, totalUsd, cashUsd, lendingUsd, investUsd, pricedAt } = portfolio

  if (lines.length === 0) {
    return (
      <div className="vw-panel" style={{ padding: '8px 28px 18px' }} aria-label="Portfolio">
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          padding: '20px 0 6px',
        }}>
          <Label>Portfolio</Label>
        </div>
        <p style={{ fontSize: '13px', color: 'rgba(246,247,248,0.4)', padding: '14px 0' }}>
          No assets yet.
        </p>
      </div>
    )
  }

  const cash    = lines.filter((l) => l.kind === 'cash')
  const lending = lines.filter((l) => l.kind === 'lending')
  const invest  = lines.filter((l) => l.kind === 'invest')

  const totalLabel = totalUsd !== null
    ? formatFiat(totalUsd, currencyCode, fxRate)
    : '—'

  const pricedAtLabel = new Date(pricedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <div className="vw-panel" style={{ padding: '8px 28px 18px' }} aria-label="Portfolio summary">
      {/* Card header: title + total */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        padding: '20px 0 6px',
      }}>
        <Label>Portfolio</Label>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
          <Amount className="text-[15px] font-semibold">
            {hideAmounts ? '••••' : totalLabel}
          </Amount>
        </span>
      </div>

      {/* Buckets */}
      <Bucket
        label="Cash"
        lines={cash}
        bucketUsd={cashUsd}
        hideAmounts={hideAmounts}
        currencyCode={currencyCode}
        fxRate={fxRate}
      />
      <Bucket
        label="Lending"
        lines={lending}
        bucketUsd={lendingUsd}
        hideAmounts={hideAmounts}
        currencyCode={currencyCode}
        fxRate={fxRate}
      />
      <Bucket
        label="Invest"
        lines={invest}
        bucketUsd={investUsd}
        hideAmounts={hideAmounts}
        currencyCode={currencyCode}
        fxRate={fxRate}
      />

      {/* "Priced at HH:MM" footer */}
      <div style={{
        paddingTop: '14px',
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: '4px',
      }}>
        <span style={{ fontSize: '11px', color: 'rgba(246,247,248,0.3)' }}>
          Priced at {pricedAtLabel}
        </span>
      </div>
    </div>
  )
}
