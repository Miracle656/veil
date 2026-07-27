import { ScreenScaffold, ComingSoonBadge, colors } from '@/components/ScreenScaffold';
import { Text, View, StyleSheet } from 'react-native';

export default function ReceiveTab() {
  return (
    <ScreenScaffold
      hideBack
      eyebrow="Receive"
      title="Receive funds"
      description="Share your contract address or QR with the sender."
    >
      <View style={styles.qr}>
        <View style={styles.qrPlaceholder}>
          <Text style={styles.qrGlyph}>▦</Text>
          <Text style={styles.qrLabel}>QR placeholder</Text>
        </View>
        <Text style={styles.address}>CABC…1234 / GDEF…5678</Text>
        <Text style={styles.addressHint}>Your contract + fee-payer addresses</Text>
      </View>

      <ComingSoonBadge note="Receive screen — UI lands in a follow-up issue" />
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  qr: {
    padding: 24,
    backgroundColor: colors.surface,
    borderRadius: 18,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    gap: 10,
    marginTop: 8,
  },
  qrPlaceholder: {
    width: 180,
    height: 180,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrGlyph: { fontSize: 80, color: '#0B0B0F' },
  qrLabel: { fontSize: 9, color: '#666', marginTop: 4 },
  address: {
    color: colors.gold,
    fontFamily: 'monospace',
    fontSize: 12,
    letterSpacing: 0.6,
  },
  addressHint: { color: colors.muted, fontSize: 11 },
});
