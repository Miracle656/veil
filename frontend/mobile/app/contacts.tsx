/**
 * Address book.
 *
 * It worked before this rewrite — the storage hook was fine — but it was the
 * last screen still on raw indigo/slate hex values and system font weights, so
 * it read as a different app. Everything here is now theme tokens and brand
 * fonts, same shape as the rest of the flow screens.
 *
 * Tapping a contact sends to them, which is the reason the address book exists;
 * editing moved behind an explicit control so the common action is the easy one.
 */

import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
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
import { SafeAreaView } from 'react-native-safe-area-context';

import { FlowHeader } from '../components/FlowHeader';
import { PlusIcon, SendIcon, UsersIcon } from '../components/icons';
import { useTheme } from '../hooks/useTheme';
import { Contact, useContacts } from '../hooks/useContacts';
import { errorMessage } from '../lib/errorMessage';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';

/** Up to two initials, so the chip stays a circle rather than a pill. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const letters = parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[1][0];
  return letters.toUpperCase();
}

function shortAddress(address: string): string {
  return `${address.slice(0, 8)}…${address.slice(-8)}`;
}

export default function ContactsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

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
      setError(errorMessage(err));
    }
  };

  const handleDelete = (contact: Contact) => {
    Alert.alert('Delete contact', `Remove ${contact.name} from your address book?`, [
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

  // Deleting a contact does not touch the chain, so this only removes a
  // shortcut — the money already sent to them is unaffected.
  const sendTo = (contact: Contact) => router.push(`/send?to=${contact.address}`);

  const isFormOpen = showAddForm || editingId !== null;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.headerRow}>
        <FlowHeader title="Address book" />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.subtitle}>
          Saved addresses, kept on this phone only. Tap one to send to it.
        </Text>

        {isFormOpen ? (
          <View style={styles.form}>
            <Text style={styles.formTitle}>{editingId ? 'Edit contact' : 'New contact'}</Text>
            <TextInput
              style={styles.input}
              placeholder="Name"
              placeholderTextColor={colors.textFaint}
              value={name}
              onChangeText={setName}
              autoFocus
            />
            <TextInput
              style={[styles.input, styles.inputMono]}
              placeholder="Stellar address (G… or C…)"
              placeholderTextColor={colors.textFaint}
              value={address}
              onChangeText={(v) => setAddress(v.trim())}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <View style={styles.formActions}>
              <Pressable
                accessibilityRole="button"
                style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
                onPress={resetForm}
              >
                <Text style={styles.secondaryText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
                onPress={handleSubmit}
              >
                <Text style={styles.primaryText}>{editingId ? 'Save changes' : 'Save contact'}</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.addRow, pressed && styles.pressed]}
            onPress={startAdd}
          >
            <View style={styles.addIcon}>
              <PlusIcon size={18} color={colors.onAccent} />
            </View>
            <Text style={styles.addText}>Add a contact</Text>
          </Pressable>
        )}

        {!isLoaded ? (
          <ActivityIndicator style={styles.loader} color={colors.accent} />
        ) : contacts.length === 0 ? (
          <View style={styles.empty}>
            <UsersIcon size={28} color={colors.textFaint} />
            <Text style={styles.emptyTitle}>No contacts yet</Text>
            <Text style={styles.emptyText}>
              Save the addresses you pay often so you never have to paste one again.
            </Text>
          </View>
        ) : (
          <View style={styles.list}>
            {contacts.map((contact) => (
              <View key={contact.id} style={styles.item}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Send to ${contact.name}`}
                  style={({ pressed }) => [styles.itemMain, pressed && styles.pressed]}
                  onPress={() => sendTo(contact)}
                >
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>{initials(contact.name)}</Text>
                  </View>
                  <View style={styles.itemText}>
                    <Text style={styles.contactName} numberOfLines={1}>
                      {contact.name}
                    </Text>
                    <Text style={styles.contactAddress} numberOfLines={1}>
                      {shortAddress(contact.address)}
                    </Text>
                  </View>
                  <SendIcon size={17} color={colors.textFaint} />
                </Pressable>

                <View style={styles.itemActions}>
                  <Pressable
                    accessibilityRole="button"
                    hitSlop={8}
                    onPress={() => startEdit(contact)}
                    style={({ pressed }) => pressed && styles.pressed}
                  >
                    <Text style={styles.edit}>Edit</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    hitSlop={8}
                    onPress={() => handleDelete(contact)}
                    style={({ pressed }) => pressed && styles.pressed}
                  >
                    <Text style={styles.remove}>Delete</Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    headerRow: { paddingHorizontal: 20, paddingTop: 16 },
    container: { flexGrow: 1, padding: 20, paddingBottom: 60, gap: 16 },
    subtitle: {
      color: colors.textFaint,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
    },

    addRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 16,
      padding: 14,
    },
    addIcon: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accent,
    },
    addText: { color: colors.textPrimary, fontFamily: fontFamily.bodyMedium, fontSize: 15 },

    form: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 16,
      padding: 16,
      gap: 10,
    },
    formTitle: { color: colors.textStrong, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },
    input: {
      backgroundColor: colors.surfaceMd,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 14,
      color: colors.textPrimary,
      fontFamily: fontFamily.body,
      fontSize: 15,
    },
    inputMono: { fontFamily: fontFamily.address, fontSize: 13 },
    error: { color: colors.danger, fontFamily: fontFamily.body, fontSize: 13 },
    formActions: { flexDirection: 'row', gap: 10, marginTop: 2 },
    primary: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: 13,
      borderRadius: 100,
      backgroundColor: colors.accent,
    },
    primaryText: { color: colors.onAccent, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },
    secondary: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: 13,
      borderRadius: 100,
      borderWidth: 1,
      borderColor: colors.border,
    },
    secondaryText: { color: colors.textPrimary, fontFamily: fontFamily.bodyMedium, fontSize: 15 },

    loader: { marginTop: 32 },
    empty: { alignItems: 'center', gap: 8, paddingVertical: 40, paddingHorizontal: 20 },
    emptyTitle: { color: colors.textPrimary, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },
    emptyText: {
      color: colors.textFaint,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
      textAlign: 'center',
    },

    list: { gap: 10 },
    item: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 16,
      paddingHorizontal: 14,
      paddingVertical: 12,
      gap: 10,
    },
    itemMain: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    avatar: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceMd,
      borderWidth: 1,
      borderColor: colors.border,
    },
    avatarText: { color: colors.textSecondary, fontFamily: fontFamily.bodySemiBold, fontSize: 14 },
    itemText: { flex: 1, gap: 3 },
    contactName: { color: colors.textStrong, fontFamily: fontFamily.bodyMedium, fontSize: 15 },
    contactAddress: { color: colors.textMuted, fontFamily: fontFamily.address, fontSize: 12 },
    itemActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 18,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      paddingTop: 10,
    },
    edit: { color: colors.textSecondary, fontFamily: fontFamily.bodyMedium, fontSize: 13 },
    remove: { color: colors.danger, fontFamily: fontFamily.bodyMedium, fontSize: 13 },
    pressed: { opacity: 0.6 },
  });
