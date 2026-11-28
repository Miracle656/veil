import React from 'react'

import {
  formatAbsoluteTimestamp,
  formatVaultPositionXlm,
  positionValueDrop,
  VAULT_COPY,
  type VaultPositionValueSnapshot,
} from '@/lib/vaultPresentation'

export function VaultPositionHistory({
  history,
}: {
  history: readonly VaultPositionValueSnapshot[]
}) {
  if (history.length === 0) {
    return (
      <section className="card" aria-labelledby="position-history-title">
        <h2 id="position-history-title" style={sectionHeadingStyle}>Position value history</h2>
        <p style={emptyStyle} role="status">{VAULT_COPY.historyUnavailable}</p>
      </section>
    )
  }

  return (
    <section className="card" aria-labelledby="position-history-title">
      <h2 id="position-history-title" style={sectionHeadingStyle}>Position value history</h2>
      <ol style={{ listStyle: 'none', margin: '1rem 0 0', padding: 0 }}>
        {history.map((snapshot, index) => {
          const previous = index > 0 ? history[index - 1] : null
          const drop = previous ? positionValueDrop(previous, snapshot) : null
          return (
            <li key={`${snapshot.timestamp}-${snapshot.valueStroops}`} style={timelineItemStyle}>
              <time dateTime={new Date(snapshot.timestamp * 1_000).toISOString()}>
                {formatAbsoluteTimestamp(snapshot.timestamp)}
              </time>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', flexWrap: 'wrap' }}>
                <strong>{formatVaultPositionXlm(snapshot.valueStroops)} XLM</strong>
                {drop && (
                  <span style={dropStyle} role="alert">
                    ↓ Share value fell {drop.amountXlm} XLM ({drop.percentage.toFixed(2)}%)
                  </span>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

const sectionHeadingStyle = {
  fontFamily: 'Lora, Georgia, serif',
  fontWeight: 600,
  fontStyle: 'italic',
  fontSize: '1.125rem',
}

const emptyStyle = {
  marginTop: '0.75rem',
  fontSize: '0.8125rem',
  color: 'rgba(246,247,248,0.45)',
  lineHeight: 1.5,
}

const timelineItemStyle = {
  display: 'grid',
  gridTemplateColumns: 'minmax(160px, 0.75fr) 1fr',
  gap: '1rem',
  alignItems: 'center',
  borderTop: '1px solid var(--border-dim)',
  padding: '0.875rem 0',
  fontSize: '0.8125rem',
}

const dropStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  borderRadius: '100px',
  border: '1px solid rgba(255,130,130,0.35)',
  background: 'rgba(255,100,100,0.08)',
  color: 'rgb(255,150,150)',
  padding: '0.25rem 0.625rem',
  fontWeight: 700,
  fontSize: '0.75rem',
}
