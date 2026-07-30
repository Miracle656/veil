import { ScreenScaffold, ComingSoonBadge, colors } from '@/components/ScreenScaffold';
import { Text, View, StyleSheet } from 'react-native';

export default function EarnRoute() {
  return (
    <ScreenScaffold
      eyebrow="Earn"
      title="Yield on-chain"
      description="Deposit XLM or USDC into Blend Protocol to earn yield."
      backHref="/dashboard"
      backLabel="Dashboard"
    >
      <View style={styles.poolCard}>
        <View style={styles.poolRow}>
          <Text style={styles.poolName}>XLM pool</Text>
          <Text style={styles.poolApy}>— APY</Text>
        </View>
        <Text style={styles.poolMeta}>Total supply · — XLM</Text>
      </View>
      <View style={styles.poolCard}>
        <View style={styles.poolRow}>
          <Text style={styles.poolName}>USDC pool</Text>
          <Text style={styles.poolApy}>— APY</Text>
        </View>
        <Text style={styles.poolMeta}>Total supply · — USDC</Text>
      </View>
      <ComingSoonBadge note="Blend positions + supply/withdraw land in the earn-screen issue" />
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  poolCard: {
    padding: 18,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: 6,
  },
  poolRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  poolName: {
    color: colors.offWhite,
    fontSize: 17,
    fontWeight: '600',
  },
  poolApy: {
    color: colors.gold,
    fontSize: 13,
    fontWeight: '700',
  },
  poolMeta: {
    color: colors.muted,
    fontSize: 12,
  },
});
