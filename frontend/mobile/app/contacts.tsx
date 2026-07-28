import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useContacts } from '../hooks/useContacts';

export default function ContactsScreen() {
  const { contacts, isLoaded } = useContacts();

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Contacts</Text>
      <Text style={styles.subtitle}>Your saved Stellar addresses.</Text>

      {!isLoaded ? (
        <ActivityIndicator style={styles.loader} color="#f1f5f9" />
      ) : contacts.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No contacts saved yet.</Text>
        </View>
      ) : (
        <View style={styles.list}>
          {contacts.map((contact) => (
            <View key={contact.id} style={styles.listItem}>
              <Text style={styles.contactName}>{contact.name}</Text>
              <Text style={styles.contactAddress} numberOfLines={1}>
                {contact.address.slice(0, 10)}...{contact.address.slice(-10)}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0B0B0F',
    padding: 24,
    gap: 16,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    color: '#9BA1A6',
    fontSize: 15,
  },
  loader: {
    marginTop: 32,
  },
  empty: {
    alignItems: 'center',
    padding: 32,
  },
  emptyText: {
    color: '#64748b',
    fontSize: 14,
  },
  list: {
    backgroundColor: '#1e293b',
    borderRadius: 10,
    padding: 12,
    gap: 8,
  },
  listItem: {
    borderTopWidth: 1,
    borderTopColor: '#334155',
    paddingTop: 8,
  },
  contactName: {
    color: '#f1f5f9',
    fontSize: 15,
    fontWeight: '600',
  },
  contactAddress: {
    color: '#94a3b8',
    fontFamily: 'monospace',
    fontSize: 12,
    marginTop: 2,
  },
});
