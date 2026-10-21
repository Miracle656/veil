import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { useRouter } from 'expo-router';

export interface SignerInfo {
  key: string;
  label?: string;
  spendLimit?: string | null;
  isPrimary?: boolean;
}

export interface SignersClient {
  getSigners(walletAddress: string): Promise<SignerInfo[]>;
  addSigner(
    walletAddress: string,
    signerKey: string,
    spendLimit?: string,
  ): Promise<void>;
  removeSigner(walletAddress: string, signerKey: string): Promise<void>;
}

export interface SignersScreenProps {
  walletAddress?: string;
  client?: SignersClient;
}

function isValidStringKey(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  // Stellar edit25519 public keys are 56 characters starting with 'G'.
  return /^G[A-Z0-9]{55,56}$/.test(trimmed);
}

function formatSpendLimit(limit?: string | null): string {
  if (limit === undefined || limit === null || limit === '') {
    return 'Unlimited';
  }
  return limit;
}

export default function SignersScreen(props: SignersScreenProps) {
  const router = useRouter();
  const walletAddress = props.walletAddress ?? '';
  const client = props.client;

  const [signers, setSigners] = useState<SignerInfo[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [newKey, setNewKey] = useState<string>('');
  const [newLimit, setNewLimit] = useState<string>('');

  const loadSigners = useCallback(async () => {
    if (!client || !walletAddress) {
      setLoading(false);
      setError('Wallet address is not available.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await client.getSigners(walletAddress);
      setSigners(list);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load signers.');
    } finally {
      setLoading(false);
    }
  }, [client, walletAddress]);

  useEffect(() => {
    void loadSigners();
  }, [loadSigners]);

  const canRemove = useMemo(() => signers.length > 1, [signers.length]);

  const handleAdd = useCallback(async () => {
    if (!client) {
      Alert.alert('Unavailable', 'Wallet client is not configured.');
      return;
    }
    const trimmedKey = newKey.trim();
    if (!isValidStringKey(trimmedKey)) {
      Alert.alert('Invalid key', 'Enter a valid Stellar public key (56 characters, starting with G).');
      return;
    }
    if (signers.some((s) => s.key === trimmedKey)) {
      Alert.alert('Already a signer', 'This key is already authorized on this wallet.');
      return;
    }
    const trimmedLimit = newLimit.trim();
    if (trimmedLimit.length > 0 && !/^\d+$/.test(trimmedLimit)) {
      Alert.alert('Invalid limit', 'Spend limit must be a positive whole number of strokes.');
      return;
    }
    setSubmitting(true);
    try {
      await client.addSigner(walletAddress, trimmedKey, trimmedLimit.length > 0 ? trimmedLimit : undefined);
      setNewKey('');
      setNewLimit('');
      await loadSigners();
    } catch (cause) {
      Alert.alert('Could not add signer', cause instanceof Error ? cause.message : 'Unknown error.');
    } finally {
      setSubmitting(false);
    }
  }, [client, walletAddress, newKey, newLimit, signers, loadSigners]);

  const handleRemove = useCallback(
    async (signer: SignerInfo) => {
      if (!client) {
        Alert.alert('Unavailable', 'Wallet client is not configured.');
        return;
      }
      if (!canRemove) {
        Alert.alert(
          'Cannot remove the only signer',
          'A wallet must retain at least one signer that can authorize transactions. Add another signer before removing this one.',
        );
        return;
      }
      Alert.alert(
        'Remove signer?',
        `This key will no longer be able to sign for this wallet.\n${signer.key}`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: async () => {
              setSubmitting(true);
              try {
                await client.removeSigner(walletAddress, signer.key);
                await loadSigners();
              } catch (cause) {
                Alert.alert(
                  'Could not remove signer',
                  cause instanceof Error ? cause.message : 'Unknown error.',
                );
              } finally {
                setSubmitting(false);
              }
            },
          },
        ],
      );
    },
    [client, walletAddress, canRemove, loadSigners],
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} accessibilityRole="button">
            <Text style={styles.back}>Back</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.title}>Signers</Text>
        <Text style={styles.subtitle}>
          Keys that can authorize transactions for this wallet.
        </Text>

        {loading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator />
          </View>
        ) : error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity onPress={() => void loadSigners()} style={styles.retryButton}>
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View>
            {signers.map((signer) => (
              <View key={signer.key} style={styles.card}>
                <View style={styles.cardHeader}>
                  <Text style={styles.keyText}>{signer.key}</Text>
                  {signer.isPrimary ? (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>Primary</Text>
                    </View>
                  ) : null}
                </View>
                {signer.label ? <Text style={styles.labelText}>{signer.label}</Text> : null}
                <Text style={styles.metaText}>
                  Spend limit: {formatSpendLimit(signer.spendLimit)}
                </Text>
                <TouchableOpacity
                  onPress={() => void handleRemove(signer)}
                  disabled={!canRemove || submitting}
                  style={[
                    styles.removeButton,
                    (!canRemove || submitting) && styles.removeButtonDisabled,
                  ]}
                  accessibilityRole="button"
                >
                  <Text style={styles.removeText}>Remove</Text>
                </TouchableOpacity>
              </View>
            ))}
            {!canRemove ? (
              <Text style={styles.lastSignerNote}>
                This is the only signer. A wallet must keep at least one signer that can
                authorize transactions, so it cannot be removed. Add another signer first.
              </Text>
            ) : null}
          </View>
        )}

        <View style={styles.form}>
          <Text style={styles.formTitle}>Add signer</Text>
          <TextInput
            style={styles.input}
            placeholder="Stellar public key (G…)"
            placeholderTextColor="#888888"
            value={newKey}
            onChangeText={setNewKey}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete='off'
            editable={!submitting}
          />
          <TextInput
            style={styles.input}
            placeholder="Spend limit in strops (optional)"
            placeholderTextColor="#888888"
            value={newLimit}
            onChangeText={setNewLimit}
            keyboardType="numeric"
            editable={!submitting}
          />
          <TouchableOpacity
            onPress={() => void handleAdd()}
            disabled={submitting}
            style={[styles.addButton, submitting && styles.addButtonDisabled]}
            accessibilityRole="button"
          >
            <Text style={styles.addText}>{submitting ? 'Saving…' : 'Add signer'}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0B0B0F',
  },
  content: {
    padding: 20,
    paddingBottom: 48,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  back: {
    color: '#9CA8F0',
    fontSize: 16,
    marginRight: 16,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 8,
  },
  subtitle: {
    color: '#B3B3B3',
    fontSize: 14,
    marginBottom: 20,
  },
  loadingRow: {
    padding: 24,
    alignItems: 'center',
  },
  errorBox: {
    backgroundColor: '#2B1111',
    borderRadius: 12,
    padding: 16,
    marginBottom: 20,
  },
  errorText: {
    color: '#FFB4B4',
    fontSize: 14,
    marginBottom: 12,
  },
  retryButton: {
    alignSelf: 'flex-start',
  },
  retryText: {
    color: '#9CA8F0',
    fontSize: 14,
    fontWeight: '600',
  },
  card: {
    backgroundColor: '#17171F',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  keyText: {
    color: '#FFFFFF',
    fontSize: 13,
    flexShrink: 1,
    marginRight: 8,
  },
  badge: {
    backgroundColor: '#263255',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeText: {
    color: '#9CA8F0',
    fontSize: 11,
    fontWeight: '600',
  },
  labelText: {
    color: '#D0D0D0',
    fontSize: 13,
    marginBottom: 4,
  },
  metaText: {
    color: '#B3B3B3',
    fontSize: 13,
    marginBottom: 12,
  },
  removeButton: {
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#552B2B',
  },
  removeButtonDisabled: {
    opacity: 0.4,
  },
  removeText: {
    color: '#FFB4B4',
    fontSize: 13,
    fontWeight: '600',
  },
  lastSignerNote: {
    color: '#FFD580',
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 20,
  },
  form: {
    marginTop: 12,
    backgroundColor: '#17171F',
    borderRadius: 12,
    padding: 16,
  },
  formTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
  },
  input: {
    backgroundColor: '#0B0B0F',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2A2A35',
    color: '#FFFFFF',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    marginBottom: 12,
  },
  addButton: {
    backgroundColor: '#9CA8F0',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  addButtonDisabled: {
    opacity: 0.6,
  },
  addText: {
    color: '#0B0B0F',
    fontSize: 15,
    fontWeight: '700',
  },
});
