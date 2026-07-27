import { ScreenScaffold, ComingSoonBadge, colors } from '@/components/ScreenScaffold';
import { Text, View, StyleSheet } from 'react-native';

export default function SwapRoute() {
  return (
    <ScreenScaffold
      eyebrow="Swap"
      title="Swap tokens"
      description="Trade XLM ↔ USDC on the Stellar DEX, or route through Soroswap."
      backHref="/dashboard"
      backLabel="Dashboard"
    >
      <View style={styles.row}>
        <Text style={styles.rowLabel}>You pay</Text>
        <Text style={styles.rowValue}>0.00 XLM</Text>
      </View>
      <Text style={styles.arrow}>↓</Text>
      <View style={styles.row}>
        <Text style={styles.rowLabel}>You receive</Text>
        <Text style={styles.rowValue}>0.00 USDC</Text>
      </View>
      <ComingSoonBadge note="Quote + signing arrive in the swap-screen issue" />
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  row: {
    padding: 18,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: 6,
  },
  rowLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  rowValue: {
    color: colors.offWhite,
    fontSize: 22,
    fontWeight: '600',
  },
  arrow: {
    textAlign: 'center',
    color: colors.gold,
    fontSize: 22,
    marginVertical: 4,
  },
});
