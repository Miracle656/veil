import { StyleSheet, Text, View } from 'react-native';

/** A transaction the user is about to sign, summarised for the confirm step. */
export interface TxPreview {
  /** Verb shown in the header, e.g. "Send" or "Swap". */
  action: string;
  amount: string;
  asset: string;
  recipient?: string;
  /** For swaps: the minimum the user receives. */
  receiveAmount?: string;
  receiveAsset?: string;
  feeXlm?: string;
  memo?: string;
}

function shorten(value: string): string {
  if (value.includes('*') || value.length <= 14) return value;
  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

/**
 * Reusable transaction preview card, shown before signing. Kept presentational
 * so the same card renders on the confirm step of any flow (send, swap).
 */
export function TxPreviewCard({ preview }: { preview: TxPreview }) {
  return (
    <View style={styles.card} accessibilityLabel="Transaction preview">
      <Text style={styles.header}>{preview.action}</Text>

      <Row label="You send" value={`${preview.amount} ${preview.asset}`} strong />
      {preview.receiveAmount ? (
        <Row
          label="You receive at least"
          value={`${preview.receiveAmount} ${preview.receiveAsset ?? ''}`.trim()}
          strong
        />
      ) : null}
      {preview.recipient ? <Row label="To" value={shorten(preview.recipient)} mono /> : null}
      {preview.memo ? <Row label="Memo" value={preview.memo} /> : null}
      <Row label="Network fee" value={`~${preview.feeXlm ?? '0.00001'} XLM`} />
    </View>
  );
}

function Row({
  label,
  value,
  strong,
  mono,
}: {
  label: string;
  value: string;
  strong?: boolean;
  mono?: boolean;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, strong && styles.strong, mono && styles.mono]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: 'rgba(255,255,255,0.03)',
    padding: 20,
    gap: 12,
  },
  header: {
    color: 'rgba(246,247,248,0.4)',
    fontSize: 12,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 16,
  },
  label: {
    color: 'rgba(246,247,248,0.55)',
    fontSize: 14,
  },
  value: {
    color: '#F6F7F8',
    fontSize: 14,
    flexShrink: 1,
    textAlign: 'right',
  },
  strong: {
    fontWeight: '600',
  },
  mono: {
    fontFamily: 'monospace',
  },
});
