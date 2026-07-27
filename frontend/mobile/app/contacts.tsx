import { ScreenScaffold, ComingSoonBadge, colors } from '@/components/ScreenScaffold';
import { Text, View, StyleSheet } from 'react-native';

export default function ContactsRoute() {
  return (
    <ScreenScaffold
      eyebrow="Contacts"
      title="Saved recipients"
      description="People and addresses you can send to in one tap."
      backHref="/send"
      backLabel="Send"
    >
      <View style={styles.empty}>
        <Text style={styles.emptyGlyph}>◎</Text>
        <Text style={styles.emptyText}>No contacts yet</Text>
        <Text style={styles.emptyHint}>Screens for adding/calling contacts land in the contacts-screen issue.</Text>
      </View>
      <ComingSoonBadge />
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  empty: {
    paddingVertical: 40,
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  emptyGlyph: { color: colors.gold, fontSize: 40, lineHeight: 42 },
  emptyText: { color: colors.offWhite, fontSize: 15, fontWeight: '600' },
  emptyHint: {
    color: colors.muted,
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: 24,
    lineHeight: 16,
  },
});
