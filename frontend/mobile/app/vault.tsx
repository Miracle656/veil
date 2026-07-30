import { ScreenScaffold, ComingSoonBadge, colors } from '@/components/ScreenScaffold';
import { Text, View, StyleSheet } from 'react-native';

export default function VaultRoute() {
  return (
    <ScreenScaffold
      eyebrow="Time-locked Sub-account"
      title="Vault"
      description="Hold XLM behind a withdrawal delay. Every transfer must be queued and remains cancellable."
      backHref="/dashboard"
      backLabel="Dashboard"
    >
      <View style={styles.statRow}>
        <View style={styles.statBlock}>
          <Text style={styles.statLabel}>Balance</Text>
          <Text style={styles.statValue}>— XLM</Text>
        </View>
        <View style={styles.statBlock}>
          <Text style={styles.statLabel}>Available</Text>
          <Text style={styles.statValue}>— XLM</Text>
        </View>
      </View>
      <View style={styles.heroCard}>
        <Text style={styles.heroLabel}>Withdrawal delay</Text>
        <Text style={styles.heroValue}>— hours</Text>
      </View>
      <ComingSoonBadge note="Deposit + queue flows land in the vault-screen issue" />
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  statRow: { flexDirection: 'row', gap: 10 },
  statBlock: {
    flex: 1,
    padding: 16,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: 4,
  },
  statLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  statValue: {
    color: colors.offWhite,
    fontSize: 18,
    fontWeight: '600',
  },
  heroCard: {
    padding: 18,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: 6,
  },
  heroLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  heroValue: {
    color: colors.offWhite,
    fontSize: 22,
    fontWeight: '600',
  },
});
