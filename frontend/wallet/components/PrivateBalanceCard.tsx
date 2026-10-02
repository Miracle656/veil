'use client'

import { Amount } from '@/components/ui/primitives'
import { PRIVACY_RECOVERY_WARNING } from '@/lib/privacy/keys'

export type PrivateSyncState = 'syncing' | 'up-to-date' | 'needs-history'

export interface PrivateBalance {
  code: string
  amount: string
}

/**
 * V131 privacy feature flag. A plain boolean on purpose: the dashboard is a
 * client component, so only a NEXT_PUBLIC_ variable reaches the browser. Off
 * unless a deployment explicitly opts in.
 */
export const isV131Enabled = () => process.env.NEXT_PUBLIC_V131 === 'true'

/**
 * Shielded (pool) balances, separate from the normal balance by design.
 *
 * While `syncState` is 'syncing' or 'needs-history' the scan may not have seen
 * every note yet, so balances are never rendered — not even as zero. Only
 * 'up-to-date' shows amounts (or an empty state), and '••••' replaces every
 * amount while hidden amounts is on. Returns null when the V131 flag is off.
 *
 * `recoveryWarning` (#711) is the passkey-recovery notice: when the wallet's
 * spend key cannot be re-derived from a passkey on another device, the card
 * says so before the user moves anything into the pool.
 */
export function PrivateBalanceCard({
  balances = [],
  syncState = 'syncing',
  hideAmounts = false,
  recoveryWarning = false,
}: {
  balances?: PrivateBalance[]
  syncState?: PrivateSyncState
  hideAmounts?: boolean
  recoveryWarning?: boolean
}) {
  if (!isV131Enabled()) return null

  const statusCopy =
    syncState === 'up-to-date'
      ? 'Up to date'
      : syncState === 'needs-history'
        ? 'Needs history'
        : 'Syncing'

  return (
    <div className="vw-panel" style={{ padding: '8px 28px 18px', marginTop: '20px' }}>
      {recoveryWarning ? (
        <p
          data-testid="privacy-recovery-warning"
          style={{
            fontSize: '13px',
            lineHeight: 1.6,
            color: 'rgba(246,247,248,0.75)',
            border: '1px solid rgba(255,92,92,0.6)',
            background: 'rgba(255,92,92,0.06)',
            borderRadius: 12,
            padding: '12px 14px',
            marginTop: 14,
          }}
        >
          {PRIVACY_RECOVERY_WARNING}
        </p>
      ) : null}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '20px 0 6px' }}>
        <div className="vw-label">Private</div>
        <span className="vw-meta">{statusCopy}</span>
      </div>
      {syncState === 'syncing' ? (
        <p style={{ fontSize: '13px', color: 'rgba(246,247,248,0.4)', padding: '14px 0' }}>
          Scanning the pool for shielded notes — balances appear when the scan finishes.
        </p>
      ) : syncState === 'needs-history' ? (
        <p style={{ fontSize: '13px', color: 'rgba(246,247,248,0.4)', padding: '14px 0' }}>
          Pool history is older than the RPC window. Connect the bootnode to finish syncing.
        </p>
      ) : balances.length === 0 ? (
        <p style={{ fontSize: '13px', color: 'rgba(246,247,248,0.4)', padding: '14px 0' }}>
          No shielded balance yet.
        </p>
      ) : (
        balances.map((b) => (
          <div key={b.code} className="vw-listrow" style={{ cursor: 'default' }}>
            <span style={{ fontSize: '15px', fontWeight: 600 }}>{b.code}</span>
            <Amount className="text-[15px] font-semibold shrink-0">
              {hideAmounts ? '••••' : `${parseFloat(b.amount).toFixed(4)} ${b.code}`}
            </Amount>
          </div>
        ))
      )}
    </div>
  )
}