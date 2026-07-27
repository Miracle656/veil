import { ScreenScaffold, ComingSoonBadge, colors } from '@/components/ScreenScaffold';
import { Text, View, StyleSheet } from 'react-native';

export default function PoolsRoute() {
  return (
    <ScreenScaffold
      eyebrow="Liquidity Pools"
      title="Put capital to work"
      description="Browse active Horizon pools and deposit or withdraw with a live share estimate."
      backHref="/dashboard"
      backLabel="Dashboard"
    >
      <View style={styles.poolCard}>
        <View style={styles.poolRow}>
          <Text style={styles.poolName}>XLM / USDC</Text>
          <Text style={styles.poolFee}>0.30%</Text>
        </View>
        <View style={styles.reserveRow}>
          <View>
            <Text style={styles.reserveLabel}>Reserve A</Text>
            <Text style={styles.reserveValue}>— XLM</Text>
          </View>
          <View>
            <Text style={styles.reserveLabel}>Reserve B</Text>
            <Text style={styles.reserveValue}>— USDC</Text>
          </View>
        </View>
      </View>
      <ComingSoonBadge note="Deposit + withdraw land in the pools-screen issue" />
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
    gap: 10,
  },
  poolRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  poolName: {
    color: colors.offWhite,
    fontSize: 18,
    fontWeight: '700',
  },
  poolFee: {
    color: colors.gold,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  reserveRow: { flexDirection: 'row', justifyContent: 'space-between' },
  reserveLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  reserveValue: {
    color: colors.offWhite,
    fontSize: 14,
    fontWeight: '500',
    fontFamily: 'monospace',
  },
});
