import * as React from 'react';

/**
 * Presentational connect / disconnect button. Wire it to the wallet from
 * {@link VeilProvider} via {@link useVeilContext}:
 *
 * ```tsx
 * const { wallet } = useVeilContext();
 * <ConnectButton
 *   connected={!!wallet.address}
 *   address={wallet.address ?? undefined}
 *   loading={wallet.isPending}
 *   onConnect={() => wallet.register()}
 * />
 * ```
 */
export interface ConnectButtonProps {
  /** Whether a wallet is currently connected. */
  connected?: boolean;
  /** Connected wallet address (shown truncated). */
  address?: string;
  /** Loading state (registering / connecting). */
  loading?: boolean;
  /** Called when the user clicks Connect. */
  onConnect?: () => void;
  /** Called when the user clicks the connected pill to disconnect. */
  onDisconnect?: () => void;
  /** Label for the disconnected state. Defaults to "Connect wallet". */
  label?: string;
}

function truncate(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

const baseStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 16px',
  borderRadius: 12,
  fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
  border: '1px solid transparent',
};

export function ConnectButton({
  connected,
  address,
  loading,
  onConnect,
  onDisconnect,
  label = 'Connect wallet',
}: ConnectButtonProps) {
  if (connected) {
    return (
      <button
        type="button"
        onClick={onDisconnect}
        disabled={loading}
        style={{
          ...baseStyle,
          background: 'rgba(52,211,153,0.12)',
          borderColor: 'rgba(52,211,153,0.4)',
          color: '#34d399',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        }}
      >
        <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: '#34d399' }} />
        {address ? truncate(address) : 'Connected'}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onConnect}
      disabled={loading}
      style={{
        ...baseStyle,
        background: '#6366f1',
        color: '#fff',
        opacity: loading ? 0.6 : 1,
      }}
    >
      {loading ? 'Connecting…' : label}
    </button>
  );
}
