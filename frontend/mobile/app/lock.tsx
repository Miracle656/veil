import { ScreenScaffold, ComingSoonBadge, colors } from '@/components/ScreenScaffold';
import { View, Text, StyleSheet } from 'react-native';

export default function LockRoute() {
  return (
    <ScreenScaffold
      eyebrow="Locked"
      title="Unlock Veil"
      description="Authenticate with your device passkey to continue."
      backHref="/"
      backLabel="Home"
    >
      <View style={styles.lockCircle}>
        <Text style={styles.lockGlyph}>◉</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Why we lock</Text>
        <Text style={styles.cardText}>
          Wallet signs automatically lock when the app is backgrounded or after extended inactivity.
          Approve the passkey prompt to resume your session.
        </Text>
      </View>
      <ComingSoonBadge note="Passkey prompt wiring lands in the lock-screen issue" />
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  lockCircle: {
    alignSelf: 'center',
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: colors.surface,
    borderColor: colors.gold,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  lockGlyph: { color: colors.gold, fontSize: 38, lineHeight: 40 },
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
