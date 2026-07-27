import { ScreenScaffold, ComingSoonBadge, NavRow, colors } from '@/components/ScreenScaffold';
import { Text, View, StyleSheet } from 'react-native';

export default function SettingsTab() {
  return (
    <ScreenScaffold
      hideBack
      eyebrow="Settings"
      title="Wallet & app"
      description="Manage your session, contacts, and account recovery."
    >
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Session</Text>
      </View>
      <View style={styles.grid}>
        <NavRow href="/lock" label="Lock wallet" hint="Require passkey again" />
        <NavRow href="/recover" label="Recover wallet" hint="Restore from passkey" />
        <NavRow href="/contacts" label="Contacts" hint="Saved recipients" />
      </View>

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Network</Text>
        <Text style={styles.sectionHint}>Testnet</Text>
      </View>

      <ComingSoonBadge note="Settings screen — UI lands in a follow-up issue" />
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  sectionTitle: {
    color: colors.gold,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  sectionHint: {
    color: colors.muted,
    fontSize: 11,
  },
  grid: {
    gap: 8,
  },
});
