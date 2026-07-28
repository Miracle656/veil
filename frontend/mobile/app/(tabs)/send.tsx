import { useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';

import { isValidDestination } from '../../lib/address';
import { ContactPicker, type Contact } from '../../components/ContactPicker';

export default function SendScreen() {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  const trimmed = recipient.trim();
  const recipientValid = isValidDestination(trimmed);
  const showError = trimmed.length > 0 && !recipientValid;
  const canSubmit = recipientValid && Number(amount) > 0;

  function handleSelectContact(contact: Contact) {
    setRecipient(contact.address);
    setPickerOpen(false);
  }

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.body}>
        <Text style={styles.title}>Send</Text>

        <View style={styles.field}>
          <View style={styles.labelRow}>
            <Text style={styles.label}>RECIPIENT</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setPickerOpen(true)}
              hitSlop={8}
            >
              <Text style={styles.contactLink}>Choose contact</Text>
            </Pressable>
          </View>
          <TextInput
            style={[styles.input, showError && styles.inputError]}
            value={recipient}
            onChangeText={setRecipient}
            placeholder="Address or name*domain"
            placeholderTextColor="rgba(246,247,248,0.3)"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {showError && (
            <Text style={styles.errorText}>
              Enter a valid Stellar address (G/M/C…) or federated address (name*domain).
            </Text>
          )}
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>AMOUNT</Text>
          <TextInput
            style={styles.input}
            value={amount}
            onChangeText={setAmount}
            placeholder="0.00"
            placeholderTextColor="rgba(246,247,248,0.3)"
            keyboardType="decimal-pad"
          />
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSubmit }}
          disabled={!canSubmit}
          style={[styles.submit, !canSubmit && styles.submitDisabled]}
        >
          <Text style={styles.submitText}>Review</Text>
        </Pressable>
      </View>

      <ContactPicker
        visible={pickerOpen}
        onSelect={handleSelectContact}
        onClose={() => setPickerOpen(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#0F0F0F',
  },
  body: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 24,
    gap: 20,
  },
  title: {
    color: '#F6F7F8',
    fontSize: 28,
    fontWeight: '700',
  },
  field: {
    gap: 8,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  label: {
    color: 'rgba(246,247,248,0.4)',
    fontSize: 12,
    letterSpacing: 1,
  },
  contactLink: {
    color: '#FDDA24',
    fontSize: 13,
    fontWeight: '500',
  },
  input: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#F6F7F8',
    fontSize: 15,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  inputError: {
    borderColor: 'rgba(248,113,113,0.6)',
  },
  errorText: {
    color: '#f87171',
    fontSize: 13,
    lineHeight: 18,
  },
  submit: {
    marginTop: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 100,
    backgroundColor: '#FDDA24',
  },
  submitDisabled: {
    opacity: 0.4,
  },
  submitText: {
    color: '#0F0F0F',
    fontSize: 15,
    fontWeight: '600',
  },
});
