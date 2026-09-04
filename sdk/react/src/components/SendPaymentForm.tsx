import * as React from 'react';

export interface SendPaymentValues {
  to: string;
  amount: string;
  memo: string;
}

/**
 * Presentational send-payment form. Wire `onSubmit` to {@link useSendPayment}:
 *
 * ```tsx
 * const { mutate, isPending, error } = useSendPayment();
 * <SendPaymentForm
 *   loading={isPending}
 *   error={error?.message}
 *   onSubmit={({ to, amount }) => mutate({ feePayer, to, amount: Number(amount) })}
 * />
 * ```
 */
export interface SendPaymentFormProps {
  /** Submission handler — receives the entered field values. */
  onSubmit?: (values: SendPaymentValues) => void;
  /** Loading state (payment in flight). */
  loading?: boolean;
  /** Error message from the last attempt. */
  error?: string;
  /** Success message (e.g. a transaction hash). */
  success?: string;
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '9px 11px',
  borderRadius: 10,
  border: '1px solid rgba(148,163,184,0.25)',
  background: 'rgba(15,23,42,0.6)',
  color: '#e2e8f0',
  fontSize: 14,
  fontFamily: 'inherit',
};
const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: '#94a3b8',
  marginBottom: 4,
};

export function SendPaymentForm({ onSubmit, loading, error, success }: SendPaymentFormProps) {
  const [to, setTo] = React.useState('');
  const [amount, setAmount] = React.useState('');
  const [memo, setMemo] = React.useState('');

  const canSubmit = to.trim().length > 0 && Number(amount) > 0 && !loading;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit?.({ to: to.trim(), amount, memo });
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        width: 320,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        padding: 20,
        borderRadius: 16,
        border: '1px solid rgba(148,163,184,0.2)',
        background: 'rgba(15,23,42,0.7)',
        color: '#e2e8f0',
        fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
      }}
    >
      <div>
        <label style={labelStyle}>Recipient</label>
        <input
          style={inputStyle}
          placeholder="G… or C…"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </div>
      <div>
        <label style={labelStyle}>Amount</label>
        <input
          style={inputStyle}
          type="number"
          min="0"
          step="0.0000001"
          placeholder="0.0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>
      <div>
        <label style={labelStyle}>Memo (optional)</label>
        <input
          style={inputStyle}
          placeholder="Thanks!"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
        />
      </div>

      {error && <p style={{ margin: 0, fontSize: 13, color: '#f87171' }}>{error}</p>}
      {success && <p style={{ margin: 0, fontSize: 13, color: '#34d399' }}>{success}</p>}

      <button
        type="submit"
        disabled={!canSubmit}
        style={{
          padding: '10px 16px',
          borderRadius: 12,
          border: 'none',
          background: '#6366f1',
          color: '#fff',
          fontSize: 14,
          fontWeight: 600,
          cursor: canSubmit ? 'pointer' : 'not-allowed',
          opacity: canSubmit ? 1 : 0.5,
        }}
      >
        {loading ? 'Sending…' : 'Send payment'}
      </button>
    </form>
  );
}
