import { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Contact, useContacts } from '../hooks/useContacts';

interface ContactPickerProps {
  visible: boolean;
  onSelect: (contact: Contact) => void;
  onClose: () => void;
}

export function ContactPicker({ visible, onSelect, onClose }: ContactPickerProps) {
  const { contacts, isLoaded } = useContacts();
  const [searchTerm, setSearchTerm] = useState('');

  const filteredContacts = contacts.filter(
    (c) =>
      c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.address.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleSelect = (contact: Contact) => {
    setSearchTerm('');
    onSelect(contact);
  };

  const handleClose = () => {
    setSearchTerm('');
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>Contacts</Text>
            <Pressable onPress={handleClose} hitSlop={8}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>

          <TextInput
            style={styles.search}
            placeholder="Search name or address..."
            placeholderTextColor="#64748b"
            value={searchTerm}
            onChangeText={setSearchTerm}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {!isLoaded ? (
              <ActivityIndicator style={styles.loader} color="#f1f5f9" />
            ) : filteredContacts.length === 0 ? (
              <Text style={styles.emptyText}>
                {searchTerm ? 'No contacts found' : "You haven't saved any contacts yet."}
              </Text>
            ) : (
              filteredContacts.map((contact) => (
                <Pressable
                  key={contact.id}
                  style={styles.item}
                  onPress={() => handleSelect(contact)}
                >
                  <Text style={styles.itemName}>{contact.name}</Text>
                  <Text style={styles.itemAddress} numberOfLines={1}>
                    {contact.address.slice(0, 12)}...{contact.address.slice(-12)}
                  </Text>
                </Pressable>
              ))
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheet: {
    maxHeight: '80%',
    backgroundColor: '#0B0B0F',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: '#334155',
    padding: 20,
    gap: 14,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
  },
  closeText: {
    color: '#9BA1A6',
    fontSize: 14,
  },
  search: {
    backgroundColor: '#1e293b',
    borderRadius: 10,
    padding: 12,
    color: '#f1f5f9',
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#334155',
  },
  list: {
    flexGrow: 0,
  },
  listContent: {
    gap: 8,
    paddingBottom: 8,
  },
  loader: {
    marginVertical: 24,
  },
  emptyText: {
    color: '#64748b',
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 24,
  },
  item: {
    backgroundColor: '#1e293b',
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: '#334155',
  },
  itemName: {
    color: '#f1f5f9',
    fontSize: 15,
    fontWeight: '600',
  },
  itemAddress: {
    color: '#94a3b8',
    fontFamily: 'monospace',
    fontSize: 12,
    marginTop: 2,
  },
});
