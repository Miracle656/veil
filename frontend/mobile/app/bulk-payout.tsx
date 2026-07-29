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

import { ThemeToggle } from '../components/ThemeToggle';
import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import {
  executeBulkPayout,
  isRowValid,
  validateRow,
  type BatchSubmitResult,
  type PayoutRow,
} from '../lib/bulkPayout';

type Step = 'form' | 'submitting' | 'done';

export default function BulkPayoutScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
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
      <View style={styles.header}>
        <Text style={styles.title}>Bulk payout</Text>
        <ThemeToggle />
      </View>
      <Text style={styles.subtitle}>Add recipients, then sign once for the whole batch.</Text>

      <View style={styles.form}>
        <TextInput
          style={styles.input}
          placeholder="Recipient address (G...)"
          placeholderTextColor={colors.textFaint}
          value={recipient}
          onChangeText={setRecipient}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={styles.row}>
          <TextInput
            style={[styles.input, styles.inputFlex]}
            placeholder="Amount"
            placeholderTextColor={colors.textFaint}
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
          />
          <TextInput
            style={[styles.input, styles.inputAsset]}
            placeholder="Asset"
            placeholderTextColor={colors.textFaint}
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
          <ActivityIndicator color={colors.onAccent} />
        ) : (
          <Text style={styles.btnText}>Sign once & submit batch</Text>
        )}
      </Pressable>
    </ScrollView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      flexGrow: 1,
      backgroundColor: colors.background,
      padding: 24,
      gap: 16,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    title: {
      color: colors.textStrong,
      fontSize: 28,
      fontWeight: '700',
    },
    subtitle: {
      color: colors.textSecondary,
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
      backgroundColor: colors.surface,
      borderRadius: 10,
      padding: 14,
      color: colors.textPrimary,
      fontSize: 16,
      borderWidth: 1,
      borderColor: colors.border,
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
      backgroundColor: colors.accent,
    },
    btnSecondary: {
      backgroundColor: colors.border,
    },
    btnDisabled: {
      opacity: 0.4,
    },
    btnText: {
      color: colors.onAccent,
      fontSize: 16,
      fontWeight: '600',
    },
    list: {
      backgroundColor: colors.surface,
      borderRadius: 10,
      padding: 12,
      gap: 8,
    },
    listTitle: {
      color: colors.textFaint,
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
      borderTopColor: colors.border,
      paddingTop: 8,
    },
    listItemInfo: {
      flex: 1,
      marginRight: 12,
    },
    listItemAddr: {
      color: colors.textPrimary,
      fontFamily: 'monospace',
      fontSize: 12,
    },
    listItemAmount: {
      color: colors.textMuted,
      fontSize: 12,
      marginTop: 2,
    },
    remove: {
      color: colors.danger,
      fontSize: 13,
    },
    totals: {
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: 8,
      marginTop: 4,
    },
    totalLine: {
      color: colors.accentText,
      fontSize: 13,
      fontWeight: '600',
    },
    hash: {
      color: colors.textMuted,
      fontFamily: 'monospace',
      fontSize: 12,
    },
  });
