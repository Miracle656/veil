import { useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';

import { isValidDestination } from '../../lib/address';
import { ContactPicker } from '../../components/ContactPicker';
import { QrScanner } from '../../components/QrScanner';
import type { Contact } from '../../hooks/useContacts';

/** expo-router yields `string | string[]` for a repeated query key. */
function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export default function SendScreen() {
  // Deep links land here prefilled: `to`, `amount`, `asset` and `memo` arrive
  // from veil://send, https://app.veil.xyz/send, or a SEP-7 request forwarded
  // by /pay. Seeded as initial state so the fields stay editable afterwards.
  const params = useLocalSearchParams<{
    to?: string;
    amount?: string;
    asset?: string;
    memo?: string;
  }>();
  const asset = firstValue(params.asset) || 'XLM';
  const memo = firstValue(params.memo);

  const [recipient, setRecipient] = useState(() => firstValue(params.to));
  const [amount, setAmount] = useState(() => firstValue(params.amount));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);

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
            <View style={styles.labelActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Scan a QR code"
                onPress={() => setScannerOpen(true)}
                hitSlop={8}
              >
                <Text style={styles.contactLink}>Scan QR</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => setPickerOpen(true)}
                hitSlop={8}
              >
                <Text style={styles.contactLink}>Choose contact</Text>
              </Pressable>
            </View>
          </View>
          <TextInput
            style={[styles.input, showError && styles.inputError]}
            testID="send-recipient"
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
          <Text style={styles.label}>AMOUNT ({asset})</Text>
          <TextInput
            testID="send-amount"
            style={styles.input}
            value={amount}
            onChangeText={setAmount}
            placeholder="0.00"
            placeholderTextColor="rgba(246,247,248,0.3)"
            keyboardType="decimal-pad"
          />
        </View>

        {memo ? (
          <View style={styles.field}>
            <Text style={styles.label}>MEMO</Text>
            <Text testID="send-memo" style={styles.input}>
              {memo}
            </Text>
          </View>
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSubmit }}
          disabled={!canSubmit}
          style={[styles.submit, !canSubmit && styles.submitDisabled]}
        >
          <Text style={styles.submitText}>Review</Text>
        </Pressable>
      </View>

      <QrScanner
        visible={scannerOpen}
        onScan={(address) => {
          setRecipient(address);
          setScannerOpen(false);
        }}
        onClose={() => setScannerOpen(false)}
      />

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
  labelActions: {
    flexDirection: 'row',
    gap: 16,
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
