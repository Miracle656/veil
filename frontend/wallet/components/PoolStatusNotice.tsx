// React is imported by name because the unit tests compile JSX the classic way.
import React from 'react'

import { poolStatusInfo } from '@/lib/blendStatus'

/** A plain notice when a Blend pool is not in its normal, active state. Renders nothing when it is. */
export function PoolStatusNotice({ status }: { status: number | null }) {
  const info = poolStatusInfo(status)
  if (!info.notice) return null
  return (
    <div
      role="status"
      data-testid="pool-status-notice"
      style={{
        fontSize: '0.8125rem',
        lineHeight: 1.45,
        padding: '0.625rem 0.75rem',
        marginBottom: '0.75rem',
        borderRadius: 8,
        border: '1px solid var(--gold)',
        color: 'rgba(246,247,248,0.85)',
      }}
    >
      <strong style={{ display: 'block', marginBottom: '0.25rem' }}>{info.label}</strong>
      {info.notice}
    </div>
  )
}
