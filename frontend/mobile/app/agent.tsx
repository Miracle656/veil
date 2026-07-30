import { ScreenScaffold, ComingSoonBadge, colors } from '@/components/ScreenScaffold';
import { Text, View, StyleSheet } from 'react-native';

export default function AgentRoute() {
  return (
    <ScreenScaffold
      eyebrow="Agent"
      title="Activity feed"
      description="New incoming transfers, swaps, and on-chain events for your wallet."
      backHref="/dashboard"
      backLabel="Dashboard"
    >
      <View style={styles.empty}>
        <Text style={styles.emptyGlyph}>▽</Text>
        <Text style={styles.emptyTitle}>All caught up</Text>
        <Text style={styles.emptyHint}>New activity will appear here in real time.</Text>
      </View>
      <ComingSoonBadge note="Live feed + destination actions land in the agent-screen issue" />
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  empty: {
    paddingVertical: 40,
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  emptyGlyph: { color: colors.gold, fontSize: 40, lineHeight: 42 },
  emptyTitle: { color: colors.offWhite, fontSize: 17, fontWeight: '700' },
  emptyHint: { color: colors.muted, fontSize: 12, textAlign: 'center', paddingHorizontal: 24 },
});
