import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Contact, useContacts } from '../hooks/useContacts';

export default function ContactsScreen() {
  const { contacts, isLoaded, addContact, removeContact, updateContact } = useContacts();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setName('');
    setAddress('');
    setError(null);
    setShowAddForm(false);
    setEditingId(null);
  };

  const startAdd = () => {
    resetForm();
    setShowAddForm(true);
  };

  const startEdit = (contact: Contact) => {
    setShowAddForm(false);
    setEditingId(contact.id);
    setName(contact.name);
    setAddress(contact.address);
    setError(null);
  };

  const handleSubmit = () => {
    setError(null);
    try {
      if (editingId) {
        updateContact(editingId, { name, address });
      } else {
        addContact(name, address);
      }
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = (contact: Contact) => {
    Alert.alert('Delete contact', `Remove ${contact.name} from your contacts?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          removeContact(contact.id);
          if (editingId === contact.id) resetForm();
        },
      },
    ]);
  };

  const isFormOpen = showAddForm || editingId !== null;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Contacts</Text>
          <Text style={styles.subtitle}>Your saved Stellar addresses.</Text>
        </View>
        {!isFormOpen && (
          <Pressable style={styles.addBtn} onPress={startAdd}>
            <Text style={styles.addBtnText}>Add</Text>
          </Pressable>
        )}
      </View>

      {isFormOpen && (
        <View style={styles.form}>
          <TextInput
            style={styles.input}
            placeholder="Name"
            placeholderTextColor="#64748b"
            value={name}
            onChangeText={setName}
            autoFocus
          />
          <TextInput
            style={styles.input}
            placeholder="Stellar address (G... or C...)"
            placeholderTextColor="#64748b"
            value={address}
            onChangeText={(v) => setAddress(v.trim())}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {error && <Text style={styles.error}>{error}</Text>}
          <View style={styles.formActions}>
            <Pressable style={[styles.btn, styles.btnSecondary]} onPress={resetForm}>
              <Text style={styles.btnText}>Cancel</Text>
            </Pressable>
            <Pressable style={[styles.btn, styles.btnPrimary]} onPress={handleSubmit}>
              <Text style={styles.btnText}>{editingId ? 'Save changes' : 'Save contact'}</Text>
            </Pressable>
          </View>
        </View>
      )}

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
              <Pressable style={styles.listItemInfo} onPress={() => startEdit(contact)}>
                <Text style={styles.contactName}>{contact.name}</Text>
                <Text style={styles.contactAddress} numberOfLines={1}>
                  {contact.address.slice(0, 10)}...{contact.address.slice(-10)}
                </Text>
              </Pressable>
              <Pressable onPress={() => handleDelete(contact)}>
                <Text style={styles.remove}>Delete</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: '#0B0B0F',
    padding: 24,
    gap: 16,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    color: '#9BA1A6',
    fontSize: 15,
    marginTop: 4,
  },
  addBtn: {
    backgroundColor: '#6366f1',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 18,
  },
  addBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  form: {
    backgroundColor: '#1e293b',
    borderRadius: 10,
    padding: 16,
    gap: 10,
  },
  input: {
    backgroundColor: '#0B0B0F',
    borderRadius: 10,
    padding: 14,
    color: '#f1f5f9',
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  error: {
    color: '#f87171',
    fontSize: 13,
  },
  formActions: {
    flexDirection: 'row',
    gap: 10,
  },
  btn: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  btnPrimary: {
    backgroundColor: '#6366f1',
  },
  btnSecondary: {
    backgroundColor: '#334155',
  },
  btnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
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
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#334155',
    paddingTop: 8,
  },
  listItemInfo: {
    flex: 1,
    marginRight: 12,
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
  remove: {
    color: '#f87171',
    fontSize: 13,
  },
});
