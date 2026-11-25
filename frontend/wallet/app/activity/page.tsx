'use client'

/**
 * Full transaction history.
 *
 * The dashboard used to carry the entire feed, with filters and paging. The
 * design replaces that with a four-item preview and a "See all" link, so the
 * full list needs somewhere to live — without this route that history became
 * unreachable, which is a worse regression than the old layout ever was.
 *
 * The feed itself is hydrated by the dashboard's poller into the shared
 * `activityFeed` store, so this screen renders whatever has been fetched
 * rather than starting its own scan.
 */
import { useEffect, useState } from 'react'

import { PageHeader } from '@/components/ui/primitives'
import { TxDetailSheet, type TxRecord } from '@/components/TxDetailSheet'
import { useActivityFeed } from '@/lib/activityFeed'
import { StellarIdenticon } from '@/components/StellarIdenticon'
import { useReverseName } from '@/hooks/useReverseName'
import { walletSession } from '@/lib/walletStorage'
import type { RecurringTopupActivityItem } from '@veil/agent-recurring'

type Filter = 'all' | 'sent' | 'received' | 'swapped'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'sent', label: 'Sent' },
  { key: 'received', label: 'Received' },
  { key: 'swapped', label: 'Swaps' },
]

function label(tx: TxRecord): string {
  return tx.type === 'sent' ? 'Sent' : tx.type === 'swapped' ? 'Swapped' : 'Received'
}

/** "6:02 AM" for today, "Nov 17, 2026" for any other day. */
function when(timestamp: number): string {
  if (!timestamp) return ''
  const date = new Date(timestamp * 1000)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  return sameDay
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

function short(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-6)}` : value
}

function ActivityRow({ tx, onSelect }: { tx: TxRecord; onSelect: () => void }) {
  const { name } = useReverseName(tx.counterparty)
  const displayParty = name ?? short(tx.counterparty)

  return (
    <button
      type="button"
      className="vw-listrow"
      onClick={onSelect}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
        <StellarIdenticon address={tx.counterparty} />
        <span style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
          <span style={{ fontSize: '14px', fontWeight: 500 }}>{label(tx)}</span>
          <span className="vw-meta">{displayParty}</span>
        </span>
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px', flexShrink: 0 }}>
        {tx.type === 'swapped' ? (
          <>
            <span className="font-mono" style={{ fontSize: '14px' }}>
              -{tx.amount} {tx.asset}
            </span>
            <span className="font-mono" style={{ fontSize: '13px', color: 'var(--teal)' }}>
              +{tx.destAmount} {tx.destAsset}
            </span>
          </>
        ) : (
          <span
            className="font-mono"
            style={{ fontSize: '14px', color: tx.type === 'received' ? 'var(--teal)' : 'var(--off-white)' }}
          >
            {tx.type === 'sent' ? '-' : '+'}{tx.amount} {tx.asset}
          </span>
        )}
        <span className="vw-meta">{when(tx.timestamp)}</span>
      </span>
    </button>
  )
}

export default function ActivityPage() {
  const transactions = useActivityFeed()
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState<TxRecord | null>(null)

  useEffect(() => {
    const walletAddress = walletSession.getItem('invisible_wallet_address')
    if (!walletAddress) return
    let cancelled = false
    fetch(`/api/recurring-topups/activity?walletAddress=${encodeURIComponent(walletAddress)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { activity?: RecurringTopupActivityItem[] } | null) => {
        if (cancelled || !data?.activity?.length) return
        const records: TxRecord[] = data.activity.map((item) => ({
          id: item.id,
          type: 'sent',
          amount: String(item.amountStableCoin),
          asset: item.coin.toUpperCase(),
          counterparty: item.depositAddress,
          timestamp: item.timestamp,
          hash: item.txHash,
          memo:
            item.status === 'failed_after_payment'
              ? `Recurring ${item.provider} ${item.category} (₦${item.amountNgn}) — order failed after payment`
              : `Recurring ${item.provider} ${item.category} (₦${item.amountNgn})`,
        }))
        appendActivityFeed(records)
      })
      .catch(() => {
        // Best-effort merge when recurring top-up activity endpoint is available.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const rows = filter === 'all' ? transactions : transactions.filter((t) => t.type === filter)

  return (
    <>
      <PageHeader eyebrow="History" title="Activity" />

      <div className="vw-more" style={{ marginTop: '18px' }}>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={filter === f.key ? 'vw-chip vw-chip--active' : 'vw-chip'}
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="vw-panel" style={{ marginTop: '20px', padding: '8px 28px 18px' }}>
        {rows.length === 0 ? (
          <p style={{ fontSize: '13px', color: 'rgba(246,247,248,0.4)', padding: '20px 0' }}>
            {transactions.length === 0
              ? 'Nothing yet. Open the dashboard to load your history.'
              : 'Nothing matches this filter.'}
          </p>
        ) : (
          rows.map((tx) => (
            <ActivityRow
              key={tx.id}
              tx={tx}
              onSelect={() => setSelected(tx)}
            />
          ))
        )}
      </div>

      {selected && <TxDetailSheet tx={selected} onClose={() => setSelected(null)} />}
    </>
  )
}
