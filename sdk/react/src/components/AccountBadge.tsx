import * as React from 'react';

/**
 * Presentational badge for a wallet account. Feed it from {@link useAccount}:
 *
 * ```tsx
 * const { data, isLoading, error } = useAccount(address, fetchAccount);
 * <AccountBadge
 *   address={data?.address}
 *   isDeployed={data?.isDeployed}
 *   loading={isLoading}
 *   error={error?.message}
 * />
 * ```
 */
export interface AccountBadgeProps {
  /** Account address (G… or C…). */
  address?: string;
  /** Whether the wallet contract is deployed on-chain. */
  isDeployed?: boolean;
  /** Loading state (e.g. the query is fetching). */
  loading?: boolean;
  /** Error message, if the account could not be loaded. */
  error?: string;
}

function truncate(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export function AccountBadge({ address, isDeployed, loading, error }: AccountBadgeProps) {
  const deployed = isDeployed ?? false;
  const statusColor = error ? '#f87171' : deployed ? '#34d399' : '#fbbf24';
  const statusLabel = error
    ? 'Error'
    : loading
      ? 'Loading…'
      : deployed
        ? 'Deployed'
        : 'Not deployed';

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        borderRadius: 999,
        border: '1px solid rgba(148,163,184,0.25)',
        background: 'rgba(15,23,42,0.6)',
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 13,
        color: '#e2e8f0',
      }}
    >
      <span
        aria-hidden
        style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor, flexShrink: 0 }}
      />
      <span>{error ? '—' : address ? truncate(address) : 'No account'}</span>
      <span style={{ fontSize: 11, color: statusColor }}>{statusLabel}</span>
    </div>
  );
}
