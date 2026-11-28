import { useMemo, useState } from 'react';
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
import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';

interface ContactPickerProps {
  visible: boolean;
  onSelect: (contact: Contact) => void;
  onClose: () => void;
}

export function ContactPicker({ visible, onSelect, onClose }: ContactPickerProps) {
  const { contacts, isLoaded } = useContacts();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
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
            placeholderTextColor={colors.textFaint}
            value={searchTerm}
            onChangeText={setSearchTerm}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <ScrollView showsVerticalScrollIndicator={false} style={styles.list} contentContainerStyle={styles.listContent}>
            {!isLoaded ? (
              <ActivityIndicator style={styles.loader} color={colors.textPrimary} />
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

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.6)',
      justifyContent: 'flex-end',
    },
    sheet: {
      maxHeight: '80%',
      backgroundColor: colors.surfaceRaised,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 20,
      gap: 14,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    title: {
      color: colors.textStrong,
      fontSize: 20,
      fontWeight: '700',
    },
    closeText: {
      color: colors.textMuted,
      fontSize: 14,
    },
    search: {
      backgroundColor: colors.surface,
      borderRadius: 10,
      padding: 12,
      color: colors.textPrimary,
      fontSize: 15,
      borderWidth: 1,
      borderColor: colors.borderStrong,
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
      color: colors.textMuted,
      fontSize: 14,
      textAlign: 'center',
      paddingVertical: 24,
    },
    item: {
      backgroundColor: colors.surface,
      borderRadius: 10,
      padding: 14,
      borderWidth: 1,
      borderColor: colors.border,
    },
    itemName: {
      color: colors.textPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
    itemAddress: {
      color: colors.textSecondary,
      fontFamily: 'monospace',
      fontSize: 12,
      marginTop: 2,
    },
  });
