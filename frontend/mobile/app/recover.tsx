import { ScreenScaffold, ComingSoonBadge, colors } from '@/components/ScreenScaffold';
import { View, Text, StyleSheet } from 'react-native';

export default function RecoverRoute() {
  return (
    <ScreenScaffold
      eyebrow="Recover"
      title="Restore your wallet"
      description="Use your existing passkey to recover your Veil wallet on a new device."
      backHref="/"
      backLabel="Home"
    >
      <View style={styles.card}>
        <Text style={styles.cardTitle}>What you&apos;ll need</Text>
        <Text style={styles.cardText}>
          • Your device passkey (Face ID / Touch ID / Windows Hello){'\n'}
          • The same iCloud Keychain / Google Password Manager account{'\n'}
          • A stable internet connection
        </Text>
      </View>
      <ComingSoonBadge note="Passkey lookup + deploy options land in the recover-screen issue" />
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
    gap: 8,
  },
  cardTitle: { color: colors.gold, fontSize: 12, fontWeight: '700', letterSpacing: 1.4, textTransform: 'uppercase' },
  cardText: { color: colors.offWhite, fontSize: 14, lineHeight: 20 },
});
