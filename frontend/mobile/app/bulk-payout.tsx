import { errorMessage } from '../lib/errorMessage';
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
import { useWallet } from '../components/WalletProvider';
import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import {
  batchProblems,
  bulkView,
  executeRowByRow,
  isRowValid,
  validateRow,
  MAX_BATCH_ROWS,
  type PayoutRow,
  type RowByRowResult,
} from '../lib/bulkPayout';
import { sendAssetFromContract } from '../lib/contractSpend';
import { deployWalletIfNeeded } from '../lib/deployWallet';
import { getWalletAddress } from '../lib/walletStore';

type Step = 'form' | 'submitting' | 'done' | 'partial';

export default function BulkPayoutScreen() {
  const { colors } = useTheme();
  const { wallet } = useWallet();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [rows, setRows] = useState<PayoutRow[]>([]);
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [asset, setAsset] = useState('XLM');
  const [step, setStep] = useState<Step>('form');
  const [result, setResult] = useState<RowByRowResult | null>(null);
  const [progress, setProgress] = useState(0);

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
    const problems = batchProblems(rows);
    if (problems.length > 0) {
      Alert.alert('Cannot send this batch', problems.join('\n'));
      return;
    }
    setStep('submitting');
    setProgress(0);
    try {
      const stored = await getWalletAddress().catch(() => null);
      if (!stored?.startsWith('C')) {
        throw new Error('No smart wallet on this device to pay from.');
      }
      // The wallet contract must exist on-chain before __check_auth can run.
      await deployWalletIfNeeded(wallet.deploy, stored);

      // One signed, submitted and confirmed transaction per recipient: a
      // Soroban transaction carries one invocation, so there is no single
      // signature for the whole list yet (see lib/bulkPayout.ts).
      const outcome = await executeRowByRow(
        rows,
        async (row, index) => {
          setProgress(index + 1);
          return sendAssetFromContract(stored, row.recipient, row.amount);
        },
        errorMessage,
      );
      setResult(outcome);
      const view = bulkView(outcome, rows.length);
      if (view === 'failed') {
        // Nothing went through: stay on the form so the batch can be retried.
        const first = outcome.outcomes.find((o) => o.status === 'failed');
        Alert.alert('Payout failed', first && first.status === 'failed' ? first.error : 'No payment was submitted.');
        setStep('form');
        return;
      }
      setStep(view);
    } catch (e: unknown) {
      Alert.alert('Payout failed', errorMessage(e));
      setStep('form');
    }
  };

  const reset = () => {
    setRows([]);
    setResult(null);
    setStep('form');
  };

  if ((step === 'done' || step === 'partial') && result) {
    const total = rows.length;
    const failedRows = result.outcomes.filter((o) => o.status === 'failed');
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>{step === 'done' ? 'Payout submitted' : 'Payout partly submitted'}</Text>
        <Text style={styles.subtitle}>
          {step === 'done'
            ? `${total} payment${total === 1 ? '' : 's'} submitted, one signed transaction each.`
            : `${result.submitted.length} of ${total} payments submitted. The rest did not go through and nothing was sent for them.`}
        </Text>
        {result.outcomes.map((o) => (
          <View key={o.index} style={styles.list}>
            <Text style={styles.listItemAddr} numberOfLines={1}>
              {rows[o.index].recipient}
            </Text>
            <Text style={styles.listItemAmount}>
              {rows[o.index].amount} {rows[o.index].asset}
            </Text>
            {o.status === 'submitted' ? <Text style={styles.hash}>{o.txHash}</Text> : null}
            {o.status === 'failed' ? <Text style={styles.remove}>Failed: {o.error}</Text> : null}
            {o.status === 'not_attempted' ? <Text style={styles.listItemAmount}>Not attempted</Text> : null}
          </View>
        ))}
        {failedRows.length > 0 || result.notAttempted.length > 0 ? (
          <Text style={styles.subtitle}>
            Did not go through: row{result.failed.length + result.notAttempted.length === 1 ? '' : 's'}{' '}
            {[...result.failed, ...result.notAttempted].map((i) => i + 1).sort((a, b) => a - b).join(', ')}.
          </Text>
        ) : null}
        <Pressable style={[styles.btn, styles.btnPrimary]} onPress={reset}>
          <Text style={styles.btnText}>Start new batch</Text>
        </Pressable>
      </ScrollView>
    );
  }

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Bulk payout</Text>
        <ThemeToggle />
      </View>
      <Text style={styles.subtitle}>{`Add up to ${MAX_BATCH_ROWS} XLM recipients. Each payment is its own signed transaction, so you confirm with your passkey once per recipient.`}</Text>

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
          <>
            <ActivityIndicator color={colors.onAccent} />
            <Text style={styles.btnText}>{`Payment ${progress} of ${rows.length}`}</Text>
          </>
        ) : (
          <Text style={styles.btnText}>Sign & submit payments</Text>
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
