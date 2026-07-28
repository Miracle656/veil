import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

export type Contact = { name: string; address: string };

// Representative saved contacts. A later issue wires the real address book;
// this is the picker surface the send form selects from.
export const SAMPLE_CONTACTS: Contact[] = [
  { name: 'Ada', address: 'GA3DHM4WL2VXPHR7NQKPZ7XK9FQJ2ULTQ6ZT4W2M5N6Q7RSTUVWXK9FQ' },
  { name: 'Chike', address: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H' },
  { name: 'Zainab', address: 'zainab*veil.money' },
];

function shorten(address: string): string {
  if (address.includes('*') || address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

type ContactPickerProps = {
  visible: boolean;
  contacts?: Contact[];
  onSelect: (contact: Contact) => void;
  onClose: () => void;
};

/** Bottom-sheet list of saved contacts; selecting one returns it to the caller. */
export function ContactPicker({
  visible,
  contacts = SAMPLE_CONTACTS,
  onSelect,
  onClose,
}: ContactPickerProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.root}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={styles.sheet}>
          <Text style={styles.title}>CHOOSE A CONTACT</Text>
          {contacts.map((contact) => (
            <Pressable
              key={contact.address}
              accessibilityRole="button"
              onPress={() => onSelect(contact)}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{contact.name.charAt(0).toUpperCase()}</Text>
              </View>
              <View style={styles.rowText}>
                <Text style={styles.name}>{contact.name}</Text>
                <Text style={styles.address}>{shorten(contact.address)}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  sheet: {
    backgroundColor: '#141418',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 32,
    gap: 4,
  },
  title: {
    color: 'rgba(246,247,248,0.55)',
    fontSize: 12,
    letterSpacing: 1,
    marginBottom: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
  },
  rowPressed: {
    opacity: 0.6,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(253,218,36,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(253,218,36,0.25)',
  },
  avatarText: {
    color: '#FDDA24',
    fontSize: 15,
    fontWeight: '600',
  },
  rowText: {
    flex: 1,
  },
  name: {
    color: '#F6F7F8',
    fontSize: 15,
    fontWeight: '500',
  },
  address: {
    color: 'rgba(246,247,248,0.4)',
    fontFamily: 'monospace',
    fontSize: 12,
    marginTop: 2,
  },
});
