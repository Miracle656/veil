import { ScreenScaffold, ComingSoonBadge, NavRow, colors } from '@/components/ScreenScaffold';
import { Text, View, StyleSheet } from 'react-native';

export default function SendTab() {
  return (
    <ScreenScaffold
      hideBack
      eyebrow="Send"
      title="Send funds"
      description="Move XLM or any asset on Stellar. Sign with your passkey."
    >
      <View style={styles.card}>
        <Text style={styles.cardLabel}>Recipient</Text>
        <Text style={styles.cardPlaceholder}>G… or C… address, contact, or @handle</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.cardLabel}>Amount</Text>
        <Text style={styles.cardPlaceholder}>0.00</Text>
      </View>

      <View style={styles.stackLinks}>
        <NavRow href="/contacts" label="Contacts" hint="Saved recipients" />
      </View>

      <ComingSoonBadge note="Send screen — UI lands in a follow-up issue" />
    </ScreenScaffold>
  );
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
