import * as React from 'react';

/**
 * Presentational balance card. Feed it from {@link useBalance}:
 *
 * ```tsx
 * const { data, isLoading, error } = useBalance();
 * <BalanceCard
 *   amount={data?.amount}
 *   assetCode={data?.assetCode}
 *   loading={isLoading}
 *   error={error?.message}
 * />
 * ```
 */
export interface BalanceCardProps {
  /** Balance amount in base units (e.g. stroops for XLM). */
  amount?: bigint | number;
  /** Asset code to display. Defaults to "XLM". */
  assetCode?: string;
  /** Decimals used to render the amount. Defaults to 7 (Stellar). */
  decimals?: number;
  /** Loading state. */
  loading?: boolean;
  /** Error message, if the balance could not be loaded. */
  error?: string;
}

function formatAmount(amount: bigint | number, decimals: number): string {
  const negative = amount < 0;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals) || '0';
  const fraction = decimals > 0 ? digits.slice(digits.length - decimals).replace(/0+$/, '') : '';
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${fraction ? `.${fraction}` : ''}`;
}

export function BalanceCard({
  amount,
  assetCode = 'XLM',
  decimals = 7,
  loading,
  error,
}: BalanceCardProps) {
  return (
    <div
      style={{
        width: 260,
        padding: 20,
        borderRadius: 16,
        border: '1px solid rgba(148,163,184,0.2)',
        background: 'linear-gradient(160deg, rgba(30,41,59,0.9), rgba(15,23,42,0.95))',
        color: '#e2e8f0',
        fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
      }}
    >
      <p style={{ margin: 0, fontSize: 12, letterSpacing: '0.08em', color: '#94a3b8' }}>BALANCE</p>
      {error ? (
        <p style={{ margin: '12px 0 0', fontSize: 14, color: '#f87171' }}>{error}</p>
      ) : loading ? (
        <p style={{ margin: '12px 0 0', fontSize: 28, fontWeight: 600, color: '#475569' }}>···</p>
      ) : (
        <p style={{ margin: '12px 0 0', fontSize: 28, fontWeight: 600, lineHeight: 1.1 }}>
          {amount === undefined ? '—' : formatAmount(amount, decimals)}{' '}
          <span style={{ fontSize: 15, fontWeight: 500, color: '#94a3b8' }}>{assetCode}</span>
        </p>
      )}
    </div>
  );
}
