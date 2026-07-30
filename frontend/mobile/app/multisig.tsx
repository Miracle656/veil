import { ScreenScaffold, ComingSoonBadge, colors } from '@/components/ScreenScaffold';
import { Text, View, StyleSheet } from 'react-native';

export default function MultisigRoute() {
  return (
    <ScreenScaffold
      eyebrow="Multisig"
      title="DAO Multisig Hub"
      description="Create M-of-N multisig wallets, propose transfers, and collect signatures on-chain."
      backHref="/dashboard"
      backLabel="Dashboard"
    >
      <View style={styles.heroCard}>
        <Text style={styles.heroLabel}>Pending</Text>
        <Text style={styles.heroValue}>0 proposals</Text>
      </View>
      <View style={styles.heroCard}>
        <Text style={styles.heroLabel}>Signers</Text>
        <Text style={styles.heroValue}>— / —</Text>
      </View>
      <ComingSoonBadge note="Wizard + queue land in the multisig-screen issue" />
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
    fontSize: 22,
    fontWeight: '600',
  },
});
