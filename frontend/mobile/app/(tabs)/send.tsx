import { ScreenScaffold, ComingSoonBadge, NavRow, colors } from '@/components/ScreenScaffold';
import { useLocalSearchParams } from 'expo-router';
import { Text, View, StyleSheet } from 'react-native';

/**
 * Send tab.
 *
 * This route owns the prefill contract deep links depend on — `to`, `amount`,
 * `asset` and `memo` arrive as query parameters from `veil://send`,
 * `https://app.veil.xyz/send`, or a SEP-7 request forwarded by `/pay`. The
 * fields are read-only placeholders until the send UI lands, but the values
 * are surfaced here so a deep link is visibly carried through end to end.
 */
export default function SendTab() {
  const params = useLocalSearchParams<{
    to?: string;
    amount?: string;
    asset?: string;
    memo?: string;
  }>();

  const recipient = firstValue(params.to);
  const amount = firstValue(params.amount);
  const asset = firstValue(params.asset) || 'XLM';
  const memo = firstValue(params.memo);

  return (
    <ScreenScaffold
      hideBack
      eyebrow="Send"
      title="Send funds"
      description="Move XLM or any asset on Stellar. Sign with your passkey."
    >
      <View style={styles.card}>
        <Text style={styles.cardLabel}>Recipient</Text>
        <Text testID="send-recipient" style={styles.cardPlaceholder} numberOfLines={1}>
          {recipient || 'G… or C… address, contact, or @handle'}
        </Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.cardLabel}>Amount</Text>
        <Text testID="send-amount" style={styles.cardPlaceholder}>
          {amount ? `${amount} ${asset}` : '0.00'}
        </Text>
      </View>

      {memo ? (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Memo</Text>
          <Text testID="send-memo" style={styles.cardPlaceholder}>
            {memo}
          </Text>
        </View>
      ) : null}

      <View style={styles.stackLinks}>
        <NavRow href="/contacts" label="Contacts" hint="Saved recipients" />
      </View>

      <ComingSoonBadge note="Send screen — UI lands in a follow-up issue" />
    </ScreenScaffold>
  );
}

/** expo-router yields `string | string[]` for a repeated query key. */
function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

const styles = StyleSheet.create({
  card: {
    padding: 18,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: 6,
  },
  cardLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  cardPlaceholder: {
    color: colors.offWhite,
    fontSize: 15,
  },
  stackLinks: { gap: 8, marginTop: 4 },
});
