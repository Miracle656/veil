/**
 * Private Send screen — Amount / Recipient → Review → Proving → Complete
 *
 * Transfers XLM out of the private pool to a recipient without revealing
 * the sender on-chain.  The recipient sees an inbound payment; the link
 * between sender and receiver is hidden by the ZK proof.
 *
 * Step machine: 'form' → 'authorizing' → 'proving' → 'submitting' → 'done' | 'error'
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';

import { useTheme } from '../../hooks/useTheme';
import { useHiddenAmounts } from '../../hooks/useHiddenAmounts';
import { useCurrency } from '../../hooks/useCurrency';
import type { ThemeColors } from '../../lib/theme';
import { fontFamily } from '../../theme/typography';
import { FlowHeader } from '../../components/FlowHeader';
import { SlideToConfirm } from '../../components/SlideToConfirm';
import { SuccessAnimation } from '../../components/SuccessAnimation';
import { ProvingProgress } from '../../components/ProvingProgress';
import { ShieldIcon, ShieldCheckIcon } from '../../components/icons';
import { requireSigner } from '../../lib/signer';
import { sendPrivate, getPrivateBalance } from '../../lib/privacy';
import { isValidDestination } from '../../lib/address';
import { fetchPrice } from '../../lib/fetchPrice';
import { truncateAddress } from '../../components/ui/AddressChip';

type Step = 'form' | 'authorizing' | 'proving' | 'submitting' | 'done' | 'error';

function firstValue(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

function trimAmt(raw: string): string {
  const n = Number(raw);
  if (!isFinite(n)) return raw;
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

export default function PrivateSendScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ to?: string; amount?: string }>();
  const { colors } = useTheme();
  const { mask } = useHiddenAmounts();
  const { format } = useCurrency();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [recipient, setRecipient] = useState(() => firstValue(params.to));
  const [amount, setAmount] = useState(() => firstValue(params.amount));
  const [price, setPrice] = useState<number | null>(null);

  const [step, setStep] = useState<Step>('form');
  const [provingPct, setProvingPct] = useState(0);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetchPrice('XLM', null).then(setPrice).catch(() => undefined);
  }, []);

  const privateBalance = Number(getPrivateBalance() ?? '0');
  const amtNum = Number(amount);
  const trimmed = recipient.trim();
  const recipientValid = isValidDestination(trimmed);
  const showRecipientError = trimmed.length > 0 && !recipientValid;
  const insufficient = amtNum > 0 && amtNum > privateBalance;
  const canSubmit =
    recipientValid &&
    amtNum > 0 &&
    !insufficient &&
    step === 'form';

  const fiatLine =
    price !== null && amtNum > 0 && isFinite(amtNum)
      ? `≈ ${format(amtNum * price)}`
      : null;

  const handleQuick = (frac: number) => {
    if (privateBalance <= 0) return;
    const val = privateBalance * frac;
    setAmount(val.toFixed(val >= 1 ? 2 : 4));
  };

  const handleConfirm = useCallback(async () => {
    setStep('authorizing');
    setError(null);
    try {
      const signer = await requireSigner();
      setStep('proving');
      setProvingPct(0);
      abortRef.current = new AbortController();
      const result = await sendPrivate(
        amount,
        trimmed,
        signer,
        (pct) => setProvingPct(pct),
        abortRef.current.signal,
      );
      setStep('submitting');
      await new Promise((r) => setTimeout(r, 300));
      setTxHash(result.hash);
      setStep('done');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      setStep('error');
    }
  }, [amount, trimmed]);

  const handleReset = () => {
    abortRef.current?.abort();
    setRecipient('');
    setAmount('');
    setProvingPct(0);
    setTxHash(null);
    setError(null);
    setStep('form');
  };

  // ── Done ──────────────────────────────────────────────────────────────────
  if (step === 'done') {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
        <View style={styles.doneWrap}>
          <SuccessAnimation
            title="Sent privately"
            subtitle={`${trimAmt(amount)} XLM → ${truncateAddress(trimmed)}`}
            FromIcon={ShieldCheckIcon}
          />
          {txHash ? (
            <View style={styles.hashCard}>
              <Text style={styles.hashLabel}>Transaction</Text>
              <Text style={styles.hashValue} numberOfLines={1}>{txHash}</Text>
            </View>
          ) : null}
          <Pressable
            onPress={handleReset}
            accessibilityRole="button"
            style={({ pressed }) => [styles.ghostBtn, pressed && styles.pressed]}
          >
            <Text style={styles.ghostBtnText}>Send again</Text>
          </Pressable>
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            style={({ pressed }) => [styles.goldBtn, pressed && styles.pressed]}
          >
            <Text style={styles.goldBtnText}>Done</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // ── Proving / Authorizing / Submitting ────────────────────────────────────
  if (step === 'proving' || step === 'submitting' || step === 'authorizing') {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
        <View style={styles.provingWrap}>
          <ShieldIcon size={48} color={colors.accent} />
          <Text style={styles.provingTitle}>
            {step === 'authorizing'
              ? 'Waiting for passkey…'
              : step === 'submitting'
              ? 'Submitting…'
              : 'Generating proof…'}
          </Text>
          {step === 'proving' ? (
            <ProvingProgress pct={provingPct} />
          ) : (
            <ActivityIndicator color={colors.accent} style={{ marginTop: 24 }} />
          )}
          <Text style={styles.provingHint}>
            {step === 'proving'
              ? 'Zero-knowledge proof is being generated on-device.\nThe sender is not revealed on-chain.'
              : step === 'submitting'
              ? 'Broadcasting transaction…'
              : 'Approve with Face ID or fingerprint.'}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  // ── Form ──────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={16}
      >
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <FlowHeader title="Private Send" />

          <Text style={styles.description}>
            Send XLM from your private balance. The transaction is shielded —
            no on-chain link connects sender to receiver.
          </Text>

          {/* Private balance chip */}
          <View style={styles.balanceRow}>
            <Text style={styles.balanceLabel}>Private balance</Text>
            <Text style={styles.balanceValue}>
              {mask(`${trimAmt(String(privateBalance))} XLM`)}
            </Text>
          </View>

          {/* Recipient field */}
          <View style={styles.inputCard}>
            <Text style={styles.inputLabel}>Recipient</Text>
            <TextInput
              style={styles.recipientInput}
              value={recipient}
              onChangeText={setRecipient}
              placeholder="G… or C… address"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Recipient address"
            />
            {showRecipientError ? (
              <Text style={styles.errorText}>Enter a valid Stellar address.</Text>
            ) : null}
          </View>

          {/* Amount field */}
          <View style={styles.inputCard}>
            <Text style={styles.inputLabel}>Amount</Text>
            <View style={styles.inputRow}>
              <TextInput
                style={styles.input}
                value={amount}
                onChangeText={setAmount}
                placeholder="0.00"
                placeholderTextColor={colors.textFaint}
                keyboardType="decimal-pad"
                returnKeyType="done"
                accessibilityLabel="Send amount"
              />
              <Text style={styles.assetTag}>XLM</Text>
            </View>
            {fiatLine ? (
              <Text style={styles.fiatLine}>{fiatLine}</Text>
            ) : null}
          </View>

          {/* Quick chips */}
          <View style={styles.quickRow}>
            {([
              { label: '25%', frac: 0.25 },
              { label: '50%', frac: 0.5 },
              { label: '75%', frac: 0.75 },
              { label: 'Max', frac: 1 },
            ] as const).map(({ label, frac }) => (
              <Pressable
                key={label}
                onPress={() => handleQuick(frac)}
                accessibilityRole="button"
                style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
              >
                <Text style={styles.chipText}>{label}</Text>
              </Pressable>
            ))}
          </View>

          {insufficient ? (
            <Text style={styles.errorText}>
              Amount exceeds your private balance.
            </Text>
          ) : null}
          {step === 'error' && error ? (
            <Text style={styles.errorText}>{error}</Text>
          ) : null}

          {/* Review card */}
          {canSubmit ? (
            <View style={styles.reviewCard}>
              <Text style={styles.reviewLabel}>Review</Text>
              <View style={styles.reviewRow}>
                <Text style={styles.reviewRowLabel}>To</Text>
                <Text style={styles.reviewRowValue} numberOfLines={1}>
                  {truncateAddress(trimmed)}
                </Text>
              </View>
              <View style={styles.reviewRow}>
                <Text style={styles.reviewRowLabel}>Amount</Text>
                <Text style={styles.reviewRowValue}>{trimAmt(amount)} XLM</Text>
              </View>
              {fiatLine ? (
                <View style={styles.reviewRow}>
                  <Text style={styles.reviewRowLabel}>Value</Text>
                  <Text style={styles.reviewRowValue}>{fiatLine}</Text>
                </View>
              ) : null}
              <View style={styles.reviewDivider} />
              <View style={styles.reviewRow}>
                <Text style={styles.reviewRowLabel}>Fee</Text>
                <Text style={styles.reviewRowValue}>Sponsored</Text>
              </View>
              <View style={styles.reviewRow}>
                <Text style={styles.reviewRowLabel}>Privacy</Text>
                <Text style={styles.reviewRowValue}>Zero-knowledge proof</Text>
              </View>
            </View>
          ) : null}
        </ScrollView>

        <View style={styles.ctaWrap}>
          <SlideToConfirm
            label="Slide to send privately"
            onConfirm={handleConfirm}
            disabled={!canSubmit}
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.background },
    flex: { flex: 1 },
    scroll: {
      paddingHorizontal: 20,
      paddingTop: 16,
      paddingBottom: 140,
      gap: 20,
    },
    description: {
      fontFamily: fontFamily.body,
      fontSize: 14,
      lineHeight: 22,
      color: c.textSecondary,
    },
    balanceRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 10,
      paddingHorizontal: 16,
      backgroundColor: 'rgba(253,218,36,0.05)',
      borderRadius: 12,
      borderWidth: 1,
      borderColor: 'rgba(253,218,36,0.15)',
    },
    balanceLabel: {
      fontFamily: fontFamily.bodyMedium,
      fontSize: 13,
      color: c.textMuted,
    },
    balanceValue: {
      fontFamily: fontFamily.address,
      fontSize: 14,
      color: c.accentText,
    },
    inputCard: {
      backgroundColor: c.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.border,
      padding: 20,
      gap: 10,
    },
    inputLabel: {
      fontFamily: fontFamily.accent,
      fontSize: 11,
      letterSpacing: 1.2,
      color: c.label,
      textTransform: 'uppercase',
    },
    recipientInput: {
      fontFamily: fontFamily.address,
      fontSize: 14,
      color: c.textPrimary,
      padding: 0,
    },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    input: {
      flex: 1,
      fontFamily: fontFamily.heading,
      fontSize: 36,
      color: c.textStrong,
      padding: 0,
    },
    assetTag: {
      fontFamily: fontFamily.accent,
      fontSize: 14,
      letterSpacing: 1,
      color: c.accent,
    },
    fiatLine: {
      fontFamily: fontFamily.address,
      fontSize: 13,
      color: c.textMuted,
    },
    quickRow: { flexDirection: 'row', gap: 8 },
    chip: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: 8,
      borderRadius: 100,
      backgroundColor: 'rgba(253,218,36,0.08)',
      borderWidth: 1,
      borderColor: 'rgba(253,218,36,0.18)',
    },
    chipPressed: { opacity: 0.65 },
    chipText: {
      fontFamily: fontFamily.bodyMedium,
      fontSize: 13,
      color: c.accent,
    },
    reviewCard: {
      backgroundColor: c.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.border,
      padding: 20,
      gap: 8,
    },
    reviewLabel: {
      fontFamily: fontFamily.accent,
      fontSize: 11,
      letterSpacing: 1.2,
      color: c.label,
      textTransform: 'uppercase',
      marginBottom: 4,
    },
    reviewRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    reviewRowLabel: {
      fontFamily: fontFamily.bodyMedium,
      fontSize: 13,
      color: c.textSecondary,
    },
    reviewRowValue: {
      fontFamily: fontFamily.bodyMedium,
      fontSize: 13,
      color: c.textPrimary,
      maxWidth: '60%',
      textAlign: 'right',
    },
    reviewDivider: {
      height: 1,
      backgroundColor: c.border,
      marginVertical: 4,
    },
    errorText: {
      fontFamily: fontFamily.body,
      fontSize: 13,
      color: c.danger,
    },
    ctaWrap: {
      paddingHorizontal: 20,
      paddingBottom: 24,
      paddingTop: 12,
      backgroundColor: c.background,
    },
    // Proving screen
    provingWrap: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
      gap: 20,
    },
    provingTitle: {
      fontFamily: fontFamily.heading,
      fontSize: 24,
      color: c.textStrong,
      textAlign: 'center',
    },
    provingHint: {
      fontFamily: fontFamily.body,
      fontSize: 13,
      color: c.textMuted,
      textAlign: 'center',
      lineHeight: 20,
    },
    // Done screen
    doneWrap: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 24,
      gap: 16,
    },
    hashCard: {
      alignSelf: 'stretch',
      backgroundColor: c.surfaceMd,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.border,
      padding: 14,
      gap: 4,
    },
    hashLabel: {
      fontFamily: fontFamily.accent,
      fontSize: 10,
      letterSpacing: 1.2,
      color: c.label,
      textTransform: 'uppercase',
    },
    hashValue: {
      fontFamily: fontFamily.address,
      fontSize: 12,
      color: c.textMuted,
    },
    goldBtn: {
      alignSelf: 'stretch',
      backgroundColor: c.accent,
      borderRadius: 100,
      paddingVertical: 14,
      alignItems: 'center',
    },
    goldBtnText: {
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
      color: c.onAccent,
    },
    ghostBtn: {
      alignSelf: 'stretch',
      borderRadius: 100,
      paddingVertical: 14,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: c.border,
    },
    ghostBtnText: {
      fontFamily: fontFamily.bodyMedium,
      fontSize: 15,
      color: c.textPrimary,
    },
    pressed: { opacity: 0.7 },
  });
