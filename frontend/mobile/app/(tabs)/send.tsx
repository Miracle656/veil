import { useState, useCallback } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';

import { isValidDestination } from '../../lib/address';
import { ContactPicker } from '../../components/ContactPicker';
import { QrScanner } from '../../components/QrScanner';
import type { Contact } from '../../hooks/useContacts';
import { requireSigner } from '../../lib/signer';
import { sendPayment } from '../../lib/sendPayment';
import { truncateAddress } from '../../components/ui/AddressChip';

/** expo-router yields `string | string[]` for a repeated query key. */
function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

type Step = 'form' | 'authorizing' | 'submitting' | 'done' | 'error';

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

  const [step, setStep] = useState<Step>('form');
  const [hash, setHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trimmed = recipient.trim();
  const recipientValid = isValidDestination(trimmed);
  const showError = trimmed.length > 0 && !recipientValid;
  const canSubmit = recipientValid && Number(amount) > 0 && (step === 'form' || step === 'error');

  function handleSelectContact(contact: Contact) {
    setRecipient(contact.address);
    setPickerOpen(false);
  }

  const handleSend = async () => {
    if (!canSubmit) return;
    setError(null);
    try {
      setStep('authorizing');
      const signer = await requireSigner();

      setStep('submitting');
      const result = await sendPayment(recipient, amount, signer);

      setHash(result.hash);
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('error');
    }
  };

  const reset = () => {
    setRecipient('');
    setAmount('');
    setStep('form');
    setHash(null);
    setError(null);
  };

  const getButtonText = () => {
    switch (step) {
      case 'authorizing':
        return 'Waiting for passkey…';
      case 'submitting':
        return 'Submitting…';
      case 'error':
        return 'Try again';
      default:
        return 'Send';
    }
  };

  return (
    <SafeAreaView style={styles.screen} testID="send-screen">
      <View style={styles.body}>
        <Text style={styles.title}>Send</Text>

        {step === 'done' ? (
          <View style={styles.resultCard}>
            <Text style={styles.resultTitle}>Payment sent</Text>
            <Text style={styles.resultLabel}>Transaction</Text>
            <Text style={styles.hash} numberOfLines={1} testID="send-hash">
              {hash ? truncateAddress(hash, 8, 8) : ''}
            </Text>
            <Pressable style={styles.submit} onPress={reset} testID="send-reset">
              <Text style={styles.submitText}>Send another</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View style={styles.field}>
              <View style={styles.labelRow}>
                <Text style={styles.label}>RECIPIENT</Text>
                <View style={styles.labelActions}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Scan a QR code"
                    onPress={() => setScannerOpen(true)}
                    hitSlop={8}
                    disabled={step === 'authorizing' || step === 'submitting'}
                  >
                    <Text style={styles.contactLink}>Scan QR</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setPickerOpen(true)}
                    hitSlop={8}
                    disabled={step === 'authorizing' || step === 'submitting'}
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
                editable={step === 'form' || step === 'error'}
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
                editable={step === 'form' || step === 'error'}
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

            {step === 'authorizing' && (
              <View style={styles.status}>
                <ActivityIndicator color="#FDDA24" />
                <Text style={styles.statusText}>Waiting for passkey…</Text>
              </View>
            )}
            {step === 'submitting' && (
              <View style={styles.status}>
                <ActivityIndicator color="#FDDA24" />
                <Text style={styles.statusText}>Submitting…</Text>
              </View>
            )}
            {step === 'error' && error && <Text style={styles.errorBannerText}>{error}</Text>}

            <Pressable
              testID="send-submit"
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSubmit }}
              disabled={!canSubmit}
              style={[styles.submit, !canSubmit && styles.submitDisabled]}
              onPress={handleSend}
            >
              <Text style={styles.submitText}>{getButtonText()}</Text>
            </Pressable>
          </>
        )}
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
  resultCard: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    padding: 20,
    gap: 8,
    marginTop: 8,
  },
  resultTitle: {
    color: '#F6F7F8',
    fontSize: 18,
    fontWeight: '700',
  },
  resultLabel: {
    color: 'rgba(246,247,248,0.4)',
    fontSize: 13,
    marginTop: 4,
  },
  hash: {
    color: '#FDDA24',
    fontSize: 14,
    fontFamily: 'monospace',
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 8,
  },
  statusText: {
    color: 'rgba(246,247,248,0.6)',
    fontSize: 14,
  },
  errorBannerText: {
    color: '#f87171',
    fontSize: 13,
    backgroundColor: 'rgba(248,113,113,0.1)',
    borderRadius: 8,
    padding: 10,
    marginTop: 8,
  },
});
