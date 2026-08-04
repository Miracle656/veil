import { ScreenScaffold, ComingSoonBadge, colors } from '@/components/ScreenScaffold';
import { useLocalSearchParams } from 'expo-router';
import { Text, View, StyleSheet } from 'react-native';

/**
 * Dynamic token detail route. `[id]` mirrors the web wallet's `[code]`
 * dynamic segment so deep links like `/token/XLM` resolve the same way.
 */
export default function TokenDetailRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id ?? 'unknown';

  return (
    <ScreenScaffold
      eyebrow="Token"
      title={id}
      description="Token detail, balances, and per-asset actions live here."
      backHref="/dashboard"
      backLabel="Dashboard"
    >
      <View style={styles.heroCard}>
        <Text style={styles.heroLabel}>Issuer</Text>
        <Text style={styles.heroValue}>—</Text>
      </View>
      <View style={styles.heroCard}>
        <Text style={styles.heroLabel}>Balance</Text>
        <Text style={styles.heroValue}>0.00 {id}</Text>
      </View>
      <ComingSoonBadge note="Per-token screen lands in the token-screen issue" />
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
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
    fontSize: 18,
    fontWeight: '600',
  },
});
