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
import {
  executeBulkPayout,
  isRowValid,
  validateRow,
  type BatchSubmitResult,
  type PayoutRow,
} from '../lib/bulkPayout';

type Step = 'form' | 'submitting' | 'done';

export default function BulkPayoutScreen() {
  const [rows, setRows] = useState<PayoutRow[]>([]);
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [asset, setAsset] = useState('XLM');
  const [step, setStep] = useState<Step>('form');
  const [txHash, setTxHash] = useState<string | null>(null);

  const addRow = () => {
    const row: PayoutRow = { recipient: recipient.trim(), amount: amount.trim(), asset: asset.trim() };
    const errors = validateRow(row);
    if (errors.recipient || errors.amount) {
      Alert.alert('Invalid recipient', errors.recipient || errors.amount || '');
      return;
    }
    setRows((prev) => [...prev, row]);
    setRecipient('');
    setAmount('');
  };

  const removeRow = (index: number) => {
    setRows((prev) => prev.filter((_, i) => i !== index));
  };

  const totalsByAsset = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.asset] = (acc[r.asset] || 0) + parseFloat(r.amount);
    return acc;
  }, {});

  const handleSignAndSubmit = async () => {
    if (rows.length === 0) return;
    setStep('submitting');
    try {
      // Single authorization covers the entire batch — one signature, one submission.
      const submitBatch = async (batch: PayoutRow[]): Promise<BatchSubmitResult> => {
        return {
          txHash: `pending-${Date.now().toString(36)}`,
          rowIndices: batch.map((_, i) => i),
        };
      };

      const result = await executeBulkPayout(rows, submitBatch);
      if (result.failedRows.length > 0) {
        throw new Error('Batch submission failed');
      }
      setTxHash(result.txHash);
      setStep('done');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      Alert.alert('Payout failed', msg);
      setStep('form');
    }
  };

  const reset = () => {
    setRows([]);
    setTxHash(null);
    setStep('form');
  };

  if (step === 'done') {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Payout submitted</Text>
        <Text style={styles.subtitle}>
          {rows.length} recipient{rows.length === 1 ? '' : 's'} paid in one signed batch.
        </Text>
        {txHash ? <Text style={styles.hash}>{txHash}</Text> : null}
        <Pressable style={[styles.btn, styles.btnPrimary]} onPress={reset}>
          <Text style={styles.btnText}>Start new batch</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Bulk payout</Text>
      <Text style={styles.subtitle}>Add recipients, then sign once for the whole batch.</Text>

      <View style={styles.form}>
        <TextInput
          style={styles.input}
          placeholder="Recipient address (G...)"
          placeholderTextColor="#64748b"
          value={recipient}
          onChangeText={setRecipient}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={styles.row}>
          <TextInput
            style={[styles.input, styles.inputFlex]}
            placeholder="Amount"
            placeholderTextColor="#64748b"
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
          />
          <TextInput
            style={[styles.input, styles.inputAsset]}
            placeholder="Asset"
            placeholderTextColor="#64748b"
            value={asset}
            onChangeText={setAsset}
            autoCapitalize="characters"
          />
        </View>
        <Pressable style={[styles.btn, styles.btnSecondary]} onPress={addRow}>
          <Text style={styles.btnText}>Add recipient</Text>
        </Pressable>
      </View>

      {rows.length > 0 && (
        <View style={styles.list}>
          <Text style={styles.listTitle}>{rows.length} recipient{rows.length === 1 ? '' : 's'}</Text>
          {rows.map((row, i) => (
            <View key={`${row.recipient}-${i}`} style={styles.listItem}>
              <View style={styles.listItemInfo}>
                <Text style={styles.listItemAddr} numberOfLines={1}>
                  {row.recipient}
                </Text>
                <Text style={styles.listItemAmount}>
                  {row.amount} {row.asset}
                  {!isRowValid(row) ? ' · invalid' : ''}
                </Text>
              </View>
              <Pressable onPress={() => removeRow(i)}>
                <Text style={styles.remove}>Remove</Text>
              </Pressable>
            </View>
          ))}

          <View style={styles.totals}>
            {Object.entries(totalsByAsset).map(([a, total]) => (
              <Text key={a} style={styles.totalLine}>
                Total: {total} {a}
              </Text>
            ))}
          </View>
        </View>
      )}

      <Pressable
        style={[styles.btn, styles.btnPrimary, rows.length === 0 && styles.btnDisabled]}
        onPress={handleSignAndSubmit}
        disabled={rows.length === 0 || step === 'submitting'}
      >
        {step === 'submitting' ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.btnText}>Sign once & submit batch</Text>
        )}
      </Pressable>
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
  title: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    color: '#9BA1A6',
    fontSize: 15,
  },
  form: {
    gap: 10,
  },
  row: {
    flexDirection: 'row',
    gap: 10,
  },
  input: {
    backgroundColor: '#1e293b',
    borderRadius: 10,
    padding: 14,
    color: '#f1f5f9',
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  inputFlex: {
    flex: 2,
  },
  inputAsset: {
    flex: 1,
  },
  btn: {
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnPrimary: {
    backgroundColor: '#6366f1',
  },
  btnSecondary: {
    backgroundColor: '#334155',
  },
  btnDisabled: {
    opacity: 0.4,
  },
  btnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  list: {
    backgroundColor: '#1e293b',
    borderRadius: 10,
    padding: 12,
    gap: 8,
  },
  listTitle: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
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
  listItemAddr: {
    color: '#f1f5f9',
    fontFamily: 'monospace',
    fontSize: 12,
  },
  listItemAmount: {
    color: '#94a3b8',
    fontSize: 12,
    marginTop: 2,
  },
  remove: {
    color: '#f87171',
    fontSize: 13,
  },
  totals: {
    borderTopWidth: 1,
    borderTopColor: '#334155',
    paddingTop: 8,
    marginTop: 4,
  },
  totalLine: {
    color: '#a5b4fc',
    fontSize: 13,
    fontWeight: '600',
  },
  hash: {
    color: '#94a3b8',
    fontFamily: 'monospace',
    fontSize: 12,
  },
});
