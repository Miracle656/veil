/**
 * Shield screen (PREVIEW) — Amount → Review → pending notice.
 *
 * Design preview of the "move XLM from public into the private pool" flow. There
 * is no SPP engine yet (see lib/privacy.ts), so confirming does NOT move funds or
 * broadcast anything: it surfaces ENGINE_PENDING_MESSAGE. The form UI is the
 * valuable part and is kept intact for when the real prover (V142) lands.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
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
import { useRouter } from 'expo-router';

import { useTheme } from '../../hooks/useTheme';
import { useHiddenAmounts } from '../../hooks/useHiddenAmounts';
import { useCurrency } from '../../hooks/useCurrency';
import type { ThemeColors } from '../../lib/theme';
import { fontFamily } from '../../theme/typography';
import { FlowHeader } from '../../components/FlowHeader';
import { SlideToConfirm } from '../../components/SlideToConfirm';
import { ShieldIcon } from '../../components/icons';
import { shieldXlm } from '../../lib/privacy';
import { isPrivacyEnabled } from '../../lib/privacy/config';
import { getWalletAddress } from '../../lib/walletStore';
import { fetchDashboardData } from '../../lib/activity';
import { fetchPrice } from '../../lib/fetchPrice';

type Step = 'form' | 'error';

const QUICK = [
  { label: '25%', frac: 0.25 },
  { label: '50%', frac: 0.5 },
  { label: '75%', frac: 0.75 },
  { label: 'Max', frac: 1 },
];

/** Max XLM left as reserve for fees / base reserve when maxing out. */
const RESERVE = 1.5;

function trimAmt(raw: string): string {
  const n = Number(raw);
  if (!isFinite(n)) return raw;
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

export default function ShieldScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { mask } = useHiddenAmounts();
  const { format } = useCurrency();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [amount, setAmount] = useState('');
  const [balance, setBalance] = useState<number | null>(null);
  const [price, setPrice] = useState<number | null>(null);

  const [step, setStep] = useState<Step>('form');
  const [error, setError] = useState<string | null>(null);

  // Load the spendable public balance.
  useEffect(() => {
    let alive = true;
    (async () => {
      const addr = await getWalletAddress().catch(() => null);
      if (!addr || !alive) return;
      const [data, p] = await Promise.all([
        fetchDashboardData(addr).catch(() => null),
        fetchPrice('XLM', null).catch(() => null),
      ]);
      if (!alive) return;
      if (data) setBalance(Number(data.xlmBalance));
      if (p !== null) setPrice(p);
    })();
    return () => { alive = false; };
  }, []);

  const spendable = balance !== null ? Math.max(0, balance - RESERVE) : null;
  const amtNum = Number(amount);
  const insufficient = spendable !== null && amtNum > 0 && amtNum > spendable;
  const canSubmit = amtNum > 0 && !insufficient && step === 'form';

  const fiatLine =
    price !== null && amtNum > 0 && isFinite(amtNum)
      ? `≈ ${format(amtNum * price)}`
      : null;

  const handleQuick = (frac: number) => {
    if (spendable === null) return;
    const val = spendable * frac;
    setAmount(val.toFixed(val >= 1 ? 2 : 4));
  };

  const handleConfirm = useCallback(async () => {
    setError(null);
    try {
      // No SPP engine yet — this always rejects with ENGINE_PENDING_MESSAGE.
      // Nothing is signed, moved, or broadcast.
      await shieldXlm();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      setStep('error');
    }
  }, []);

  const handleReset = () => {
    setError(null);
    setStep('form');
  };

  // Feature gate — off by default and unconditionally off on mainnet, so a
  // deep link can never surface the privacy UI where it must not exist.
  if (!isPrivacyEnabled()) {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
        <View style={styles.doneWrap}>
          <ShieldIcon size={48} color={colors.accent} />
          <Text style={styles.provingTitle}>Private payments are not available</Text>
          <Text style={styles.provingHint}>
            This build has the privacy feature disabled.
          </Text>
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            style={({ pressed }) => [styles.goldBtn, pressed && styles.pressed]}
          >
            <Text style={styles.goldBtnText}>Back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // ── Pending notice ──────────────────────────────────────────────────────────
  // Replaces the old success screen: with no engine, confirming lands here with
  // an honest explanation instead of a fabricated transaction hash.
  if (step === 'error') {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
        <View style={styles.doneWrap}>
          <ShieldIcon size={48} color={colors.accent} />
          <Text style={styles.provingTitle}>Private payments are pending</Text>
          <Text style={styles.provingHint}>{error}</Text>
          <Pressable
            onPress={handleReset}
            accessibilityRole="button"
            style={({ pressed }) => [styles.ghostBtn, pressed && styles.pressed]}
          >
            <Text style={styles.ghostBtnText}>Back to form</Text>
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

  // ── Form ────────────────────────────────────────────────────────────────────
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
          {/* Header */}
          <FlowHeader title="Shield" />

          {/* Description */}
          <Text style={styles.description}>
            Preview of the shield flow. Private payments are not live in this
            build yet — confirming will not move any funds or broadcast a
            transaction.
          </Text>

          {/* Balance row */}
          {balance !== null ? (
            <View style={styles.balanceRow}>
              <Text style={styles.balanceLabel}>Available</Text>
              <Text style={styles.balanceValue}>
                {mask(`${trimAmt(String(spendable ?? 0))} XLM`)}
              </Text>
            </View>
          ) : null}

          {/* Amount input */}
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
                accessibilityLabel="Shield amount"
              />
              <Text style={styles.assetTag}>XLM</Text>
            </View>
            {fiatLine ? (
              <Text style={styles.fiatLine}>{fiatLine}</Text>
            ) : null}
          </View>

          {/* Quick-select chips */}
          <View style={styles.quickRow}>
            {QUICK.map(({ label, frac }) => (
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

          {/* Validation message */}
          {insufficient ? (
            <Text style={styles.errorText}>Amount exceeds your available balance.</Text>
          ) : null}
          {error ? (
            <Text style={styles.errorText}>{error}</Text>
          ) : null}

          {/* Review card — shown when amount is valid */}
          {canSubmit ? (
            <View style={styles.reviewCard}>
              <Text style={styles.reviewLabel}>You will shield</Text>
              <Text style={styles.reviewAmount}>{trimAmt(amount)} XLM</Text>
              {fiatLine ? <Text style={styles.reviewFiat}>{fiatLine}</Text> : null}
              <View style={styles.reviewDivider} />
              <View style={styles.reviewRow}>
                <Text style={styles.reviewRowLabel}>Fee</Text>
                <Text style={styles.reviewRowValue}>Sponsored</Text>
              </View>
              <View style={styles.reviewRow}>
                <Text style={styles.reviewRowLabel}>Status</Text>
                <Text style={styles.reviewRowValue}>Preview — engine pending</Text>
              </View>
            </View>
          ) : null}
        </ScrollView>

        {/* Slide to confirm — fixed at bottom */}
        <View style={styles.ctaWrap}>
          <SlideToConfirm
            label="Slide to shield"
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

    // Description
    description: {
      fontFamily: fontFamily.body,
      fontSize: 14,
      lineHeight: 22,
      color: c.textSecondary,
    },

    // Balance row
    balanceRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 10,
      paddingHorizontal: 16,
      backgroundColor: c.surfaceMd,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.border,
    },
    balanceLabel: {
      fontFamily: fontFamily.bodyMedium,
      fontSize: 13,
      color: c.textMuted,
    },
    balanceValue: {
      fontFamily: fontFamily.address,
      fontSize: 14,
      color: c.textPrimary,
    },

    // Amount input card
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

    // Quick-select chips
    quickRow: {
      flexDirection: 'row',
      gap: 8,
    },
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

    // Review card
    reviewCard: {
      backgroundColor: c.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.border,
      padding: 20,
      gap: 6,
    },
    reviewLabel: {
      fontFamily: fontFamily.accent,
      fontSize: 11,
      letterSpacing: 1.2,
      color: c.label,
      textTransform: 'uppercase',
      marginBottom: 4,
    },
    reviewAmount: {
      fontFamily: fontFamily.heading,
      fontSize: 28,
      color: c.textStrong,
    },
    reviewFiat: {
      fontFamily: fontFamily.address,
      fontSize: 13,
      color: c.textMuted,
    },
    reviewDivider: {
      height: 1,
      backgroundColor: c.border,
      marginVertical: 8,
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
    },

    // Error
    errorText: {
      fontFamily: fontFamily.body,
      fontSize: 13,
      color: c.danger,
    },

    // CTA
    ctaWrap: {
      paddingHorizontal: 20,
      paddingBottom: 24,
      paddingTop: 12,
      backgroundColor: c.background,
    },

    // Proving / loading screen
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
