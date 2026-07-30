import { ScreenScaffold, ComingSoonBadge, colors } from '@/components/ScreenScaffold';
import { Text, View, StyleSheet } from 'react-native';

export default function WithdrawRoute() {
  return (
    <ScreenScaffold
      eyebrow="Withdraw"
      title="Cash out"
      description="SEP-24 fiat off-ramp. Complete KYC, then send funds to the anchor."
      backHref="/dashboard"
      backLabel="Dashboard"
    >
      <View style={styles.card}>
        <Text style={styles.cardLabel}>Asset</Text>
        <Text style={styles.cardValue}>XLM</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.cardLabel}>Anchor</Text>
        <Text style={styles.cardValue}>—</Text>
      </View>
      <ComingSoonBadge note="SEP-10 + interactive flow lands in the withdraw-screen issue" />
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
  cardValue: {
    color: colors.offWhite,
    fontSize: 18,
    fontWeight: '600',
  },
});
