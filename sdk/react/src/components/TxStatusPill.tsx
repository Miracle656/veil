import * as React from 'react';

export type TxStatus = 'PENDING' | 'SUCCESS' | 'FAILED' | 'NOT_FOUND';

/**
 * Presentational transaction-status pill. Feed it from {@link useTransactionStatus}:
 *
 * ```tsx
 * const { data, isLoading } = useTransactionStatus(hash, fetchStatus);
 * <TxStatusPill status={data?.status} hash={data?.hash} loading={isLoading} />
 * ```
 */
export interface TxStatusPillProps {
  /** Current transaction status. */
  status?: TxStatus;
  /** Transaction hash (rendered truncated, if given). */
  hash?: string;
  /** Loading state (status still being polled). */
  loading?: boolean;
  /** Error detail shown for a FAILED status. */
  errorMessage?: string;
}

const STYLES: Record<TxStatus, { label: string; fg: string; bg: string }> = {
  PENDING: { label: 'Pending', fg: '#fbbf24', bg: 'rgba(251,191,36,0.12)' },
  SUCCESS: { label: 'Success', fg: '#34d399', bg: 'rgba(52,211,153,0.12)' },
  FAILED: { label: 'Failed', fg: '#f87171', bg: 'rgba(248,113,113,0.12)' },
  NOT_FOUND: { label: 'Not found', fg: '#94a3b8', bg: 'rgba(148,163,184,0.12)' },
};

export function TxStatusPill({ status, hash, loading, errorMessage }: TxStatusPillProps) {
  const resolved: TxStatus = loading ? 'PENDING' : (status ?? 'NOT_FOUND');
  const s = STYLES[resolved];
  const title = resolved === 'FAILED' && errorMessage ? errorMessage : undefined;

  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 11px',
        borderRadius: 999,
        background: s.bg,
        color: s.fg,
        fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
        fontSize: 13,
        fontWeight: 600,
      }}
    >
      <span
        aria-hidden
        style={{ width: 7, height: 7, borderRadius: '50%', background: s.fg, flexShrink: 0 }}
      />
      {loading ? 'Polling…' : s.label}
      {hash && (
        <span
          style={{
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontWeight: 400,
            opacity: 0.7,
          }}
        >
          {hash.slice(0, 6)}…
        </span>
      )}
    </span>
  );
}
