/**
 * Shared bill payment screen (`form` → `confirm` → `paying` → `done` / `failed`).
 *
 * Owns everything that is identical across airtime, data, electricity, cable TV,
 * and betting:
 *
 *   - mainnet gating (`networkName === 'mainnet'`)
 *   - resolving `customerRef` and `refundAddress` (the classic `G…` fee-payer)
 *   - loading the per-coin NGN rate (`xlm` / `usdc`)
 *   - one-time NIN verification check (`isNairaVerified`) and `/verify` bounce
 *   - amount and asset selection (or a category-supplied fixed bundle amount)
 *   - `previewSpendFee` on the confirm step before the passkey prompt
 *   - reserving the order first (`payBill`) and spending the locked crypto
 *     amount second (`spendAsset`)
 *   - polling `getBillStatus` until delivered or refunded, without ever
 *     treating a transient poll failure as a failed payment after funds have
 *     left the wallet
 *
 * Category-specific inputs, validation, provider lookups, and copy stay on the
 * caller's side of the seam (see `lib/billFlow.ts`).
 */

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useRouter } from 'expo-router';

import { FlowHeader } from './FlowHeader';
import { SlideToConfirm } from './SlideToConfirm';
import { useWallet } from './WalletProvider';
import { useTheme } from '../hooks/useTheme';
import { useNetwork } from '../hooks/useNetwork';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { errorMessage } from '../lib/errorMessage';
import { getAssetIssuer } from '../lib/assets';
import { getFeePayerAddress } from '../lib/activity';
import { NotEnoughToSend, previewSpendFee } from '../lib/spendAsset';
import { isPasskeyCancellation } from '../lib/passkeyOutcome';
import type { PlatformFee } from '../lib/platformFee';
import {
  getBillStatus,
  getCustomerRef,
  getOnrampRate,
  isNairaVerified,
  type NairaCoin,
} from '../lib/onramp';
import {
  canContinueBillForm,
  classifyBillPollStatus,
  computeBillCryptoCost,
  DEFAULT_QUICK_AMOUNTS,
  executeBillPayment,
  formatNaira,
  parseBillAmountNgn,
  type BillCategoryConfig,
  type BillRateState,
  type BillStep,
} from '../lib/billFlow';

export interface BillFlowProps extends BillCategoryConfig {
  /** Category-specific form fields rendered above the amount and asset controls. */
  children: ReactNode;
  /**
   * Optional error raised by a category field action (such as the contact
   * picker in `airtime.tsx`), rendered in the shared error banner.
   */
  fieldError?: string | null;
  /** Called when the shared flow clears errors on retry or step transition. */
  onClearFieldError?: () => void;
  /**
   * Optional fixed NGN amount supplied by a bundle/bouquet picker (e.g. data or
   * cable TV plans). When provided, overrides the free-form amount input.
   */
  presetAmountNgn?: number | null;
}

export function BillFlow({
  category,
  title,
  returnTo,
  provider,
  customerId,
  customerValid,
  quickAmounts = DEFAULT_QUICK_AMOUNTS,
  copy,
  children,
  fieldError = null,
  onClearFieldError,
  presetAmountNgn = null,
}: BillFlowProps) {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createBillFlowStyles(colors), [colors]);
  const { wallet } = useWallet();

  const { networkName } = useNetwork();
  const mainnetOnly = networkName !== 'mainnet';

  const [step, setStep] = useState<BillStep>('form');
  const [error, setError] = useState<string | null>(null);

  const [amountNGN, setAmountNGN] = useState('');
  const [coin, setCoin] = useState<NairaCoin>('usdc');

  const [rate, setRate] = useState<number | null>(null);
  const [rateState, setRateState] = useState<BillRateState>('loading');

  const [customerRef, setCustomerRef] = useState<string | null>(null);
  const [refundAddress, setRefundAddress] = useState<string | null>(null);

  const [orderId, setOrderId] = useState<string | null>(null);
  const [payHash, setPayHash] = useState<string | null>(null);
  // Shown before the passkey, never after. `previewSpendFee` decides the fee
  // the same way `spendAsset` will, so the figure on the confirm screen matches
  // what is actually charged.
  const [veilFee, setVeilFee] = useState<PlatformFee | null>(null);
  const [spent, setSpent] = useState<number | null>(null);
  const [waitingForPasskey, setWaitingForPasskey] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [addr, ref] = await Promise.all([
        getFeePayerAddress().catch(() => null),
        getCustomerRef().catch(() => null),
      ]);
      if (cancelled) return;
      setRefundAddress(addr);
      setCustomerRef(ref);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadRate = useCallback(async () => {
    if (mainnetOnly) return;
    setRateState('loading');
    try {
      setRate(await getOnrampRate(coin));
      setRateState('ready');
    } catch {
      setRate(null);
      setRateState('failed');
    }
  }, [mainnetOnly, coin]);

  useEffect(() => {
    void loadRate();
  }, [loadRate]);

  // Poll the vend result once the on-chain deposit has left the wallet.
  useEffect(() => {
    if (!orderId || !customerRef || step !== 'paying' || !payHash) return;
    const check = async () => {
      try {
        const s = await getBillStatus(customerRef, orderId);
        const outcome = classifyBillPollStatus(s.status);
        if (outcome === 'done') setStep('done');
        if (outcome === 'failed') setStep('failed');
      } catch (err) {
        // Silent to the user: the payment has already left the wallet, so
        // surfacing a poll network error would falsely suggest the payment did
        // not go through. Logged so support/debugging can still see it.
        console.warn(`[${category}] status poll failed:`, errorMessage(err));
      }
    };
    void check();
    pollRef.current = setInterval(check, 10_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [orderId, customerRef, step, payHash, category]);

  const ngn = presetAmountNgn !== null ? presetAmountNgn : parseBillAmountNgn(amountNGN);
  const code = coin.toUpperCase();
  const cost = computeBillCryptoCost(ngn, rate);
  const formattedNgn = formatNaira(ngn);

  // Only on the confirm step: `previewSpendFee` reads two balances, and running
  // it on every keystroke of the amount input would fire a request per digit.
  useEffect(() => {
    if (step !== 'confirm' || cost <= 0) return;
    let cancelled = false;
    void (async () => {
      const issuer = coin === 'usdc' ? getAssetIssuer('USDC', 'mainnet') : null;
      const fee = await previewSpendFee({
        amount: String(cost),
        ...(issuer ? { asset: { code: 'USDC', issuer } } : {}),
      }).catch(() => null);
      if (!cancelled) setVeilFee(fee);
    })();
    return () => {
      cancelled = true;
    };
  }, [step, cost, coin]);

  const continueFromForm = useCallback(async () => {
    setError(null);
    onClearFieldError?.();
    if (await isNairaVerified()) {
      setStep('confirm');
      return;
    }
    router.push({
      pathname: '/verify',
      params: {
        returnTo,
        label: title,
        summary: copy.verifySummary(formattedNgn),
      },
    });
  }, [router, returnTo, title, copy, formattedNgn, onClearFieldError]);

  const pay = useCallback(async () => {
    if (!customerRef || !refundAddress || !rate) return;
    setStep('paying');
    setError(null);
    onClearFieldError?.();
    try {
      const { txHash } = await executeBillPayment({
        customerRef,
        billCategory: category,
        provider,
        customerId,
        amountNgn: ngn,
        rate,
        coin,
        refundAddress,
        deploy: wallet.deploy,
        onOrderReserved: (order, amountStableCoin) => {
          setOrderId(order.id);
          setSpent(amountStableCoin);
        },
        onBeforePasskey: () => setWaitingForPasskey(true),
        onAfterPasskey: () => setWaitingForPasskey(false),
      });
      setPayHash(txHash);
    } catch (err) {
      setWaitingForPasskey(false);
      // Back to the confirmation with the order intact and no red error: the
      // user simply chose not to authorise, and no crypto left the wallet.
      if (isPasskeyCancellation(err)) {
        setError(null);
        setStep('confirm');
        return;
      }
      if (err instanceof NotEnoughToSend) {
        const noun = copy.insufficientBalanceNoun ?? 'top-up';
        setError(
          `This wallet holds ${err.available.toLocaleString('en-US', { maximumFractionDigits: 7 })} ${code}, less than this ${noun} needs.`,
        );
      } else {
        setError(errorMessage(err));
      }
      setStep('confirm');
    }
  }, [
    customerRef,
    refundAddress,
    rate,
    category,
    provider,
    customerId,
    ngn,
    coin,
    wallet.deploy,
    copy.insufficientBalanceNoun,
    code,
    onClearFieldError,
  ]);

  const canContinue = canContinueBillForm({
    customerValid,
    amountNgn: ngn,
    rateState,
  });
  const activeError = error ?? fieldError;
  const stepNumber = step === 'form' ? 1 : 2;
  const formattedSpent = `${(spent ?? cost).toFixed(coin === 'xlm' ? 4 : 2)} ${code}`;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <FlowHeader title={title} />
        {!mainnetOnly && (step === 'form' || step === 'confirm') ? (
          <View style={styles.progressRow}>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { flex: stepNumber }]} />
              <View style={{ flex: 2 - stepNumber }} />
            </View>
            <Text style={styles.progressLabel}>{stepNumber} / 2</Text>
          </View>
        ) : null}
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={16}
      >
        <ScrollView
          style={styles.flex}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
        >
          {mainnetOnly ? (
            <View style={styles.card}>
              <Text style={styles.eyebrow}>MAINNET ONLY</Text>
              <Text style={styles.question}>{copy.mainnetTitle}</Text>
              <Text style={styles.hint}>{copy.mainnetHint}</Text>
            </View>
          ) : null}

          {activeError ? (
            <View style={styles.errorCard}>
              <Text style={styles.errorText}>{activeError}</Text>
            </View>
          ) : null}

          {/* ── b1 · form ─────────────────────────────────────────────────── */}
          {!mainnetOnly && step === 'form' && (
            <>
              {children}

              {presetAmountNgn === null ? (
                <>
                  <Text style={styles.label}>AMOUNT</Text>
                  <View style={styles.amountRow}>
                    <Text style={styles.currency}>₦</Text>
                    <TextInput
                      style={styles.amountInput}
                      value={amountNGN}
                      onChangeText={(t) => setAmountNGN(t.replace(/[^\d]/g, ''))}
                      keyboardType="number-pad"
                      placeholder="0"
                      placeholderTextColor={colors.textMuted}
                    />
                  </View>
                  <View style={styles.quickRow}>
                    {quickAmounts.map((q) => (
                      <Pressable
                        key={q}
                        onPress={() => setAmountNGN(String(q))}
                        style={styles.quickChip}
                      >
                        <Text style={styles.quickText}>₦{q.toLocaleString('en-NG')}</Text>
                      </Pressable>
                    ))}
                  </View>
                </>
              ) : null}

              <View style={styles.segment}>
                {(['xlm', 'usdc'] as NairaCoin[]).map((c) => (
                  <Pressable
                    key={c}
                    onPress={() => setCoin(c)}
                    style={[styles.segmentItem, coin === c && styles.segmentActive]}
                  >
                    <Text style={[styles.segmentText, coin === c && styles.segmentTextActive]}>
                      {c.toUpperCase()}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <View style={styles.card}>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Costs</Text>
                  <Text style={styles.rowValueStrong}>
                    {rateState === 'ready' && cost > 0
                      ? `${cost.toFixed(coin === 'xlm' ? 4 : 2)} ${code}`
                      : rateState === 'loading'
                        ? 'Checking…'
                        : '—'}
                  </Text>
                </View>
                {rateState === 'failed' ? (
                  <Pressable onPress={() => void loadRate()}>
                    <Text style={styles.linkText}>Rate unavailable — try again</Text>
                  </Pressable>
                ) : null}
              </View>

              <Pressable
                onPress={() => void continueFromForm()}
                disabled={!canContinue}
                style={({ pressed }) => [
                  styles.primaryBtn,
                  !canContinue && styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.primaryText}>Continue</Text>
              </Pressable>
            </>
          )}

          {/* ── b2 · confirm ──────────────────────────────────────────────── */}
          {!mainnetOnly && step === 'confirm' && (
            <>
              <View style={styles.card}>
                <Text style={styles.question}>{copy.confirmQuestion(formattedNgn)}</Text>
                <Text style={styles.money}>
                  {cost.toFixed(coin === 'xlm' ? 4 : 2)} {code}
                </Text>
              </View>

              <View style={styles.card}>
                {copy.confirmRows.map((r) => (
                  <View key={r.label} style={styles.row}>
                    <Text style={styles.rowLabel}>{r.label}</Text>
                    <Text style={styles.rowValue}>{r.value}</Text>
                  </View>
                ))}
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Paid from</Text>
                  <Text style={styles.rowValue}>{code} balance</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Network fee</Text>
                  <Text style={styles.rowValue}>Sponsored</Text>
                </View>
                {veilFee ? (
                  <View style={styles.row}>
                    <Text style={styles.rowLabel}>Veil fee</Text>
                    <Text style={styles.rowValue}>
                      {veilFee.amount} {veilFee.assetCode}
                    </Text>
                  </View>
                ) : null}
              </View>

              <View style={styles.noteCard}>
                <Text style={styles.hint}>{copy.refundNote}</Text>
              </View>

              <SlideToConfirm label="Slide to pay" onConfirm={() => void pay()} />
              <Text style={styles.centeredHint}>Then confirm with your passkey</Text>

              <Pressable onPress={() => setStep('form')}>
                <Text style={styles.linkText}>Back</Text>
              </Pressable>
            </>
          )}

          {/* ── b3 · passkey / in flight ──────────────────────────────────── */}
          {!mainnetOnly && step === 'paying' && (
            <>
              <View style={styles.card}>
                <Text style={styles.question}>
                  {waitingForPasskey ? 'Confirm with your passkey' : copy.payingTitle}
                </Text>
                <Text style={styles.hint}>
                  {waitingForPasskey
                    ? 'Face ID, fingerprint or device PIN, whichever this phone uses.'
                    : copy.payingHint(formattedNgn)}
                </Text>
              </View>

              <View style={styles.card}>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>{copy.payingSummaryLabel}</Text>
                  <Text style={styles.rowValue}>{copy.payingSummaryValue(formattedNgn)}</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>You spend</Text>
                  <Text style={styles.rowValue}>{formattedSpent}</Text>
                </View>
              </View>

              <View style={styles.waitRow}>
                <ActivityIndicator color={colors.accent} />
                <Text style={styles.hint}>
                  {waitingForPasskey ? 'Waiting for your passkey…' : copy.payingWaitLabel}
                </Text>
              </View>
            </>
          )}

          {/* ── b4 · done ─────────────────────────────────────────────────── */}
          {!mainnetOnly && step === 'done' && (
            <>
              <View style={styles.card}>
                <Text style={styles.question}>{copy.doneTitle}</Text>
                <Text style={styles.hint}>{copy.doneHint(formattedNgn)}</Text>
              </View>

              <View style={styles.card}>
                {copy.doneRows.map((r) => (
                  <View key={r.label} style={styles.row}>
                    <Text style={styles.rowLabel}>{r.label}</Text>
                    <Text style={styles.rowValue}>{r.value}</Text>
                  </View>
                ))}
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>You spent</Text>
                  <Text style={styles.rowValue}>{formattedSpent}</Text>
                </View>
                {orderId ? (
                  <View style={styles.row}>
                    <Text style={styles.rowLabel}>Reference</Text>
                    <Text style={styles.rowValue}>{orderId.slice(0, 8).toUpperCase()}</Text>
                  </View>
                ) : null}
              </View>

              <Pressable
                onPress={() => {
                  setStep('form');
                  setAmountNGN('');
                  setOrderId(null);
                  setPayHash(null);
                  setSpent(null);
                  void loadRate();
                }}
                style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
              >
                <Text style={styles.primaryText}>{copy.doneAgainLabel ?? 'Buy again'}</Text>
              </Pressable>
              <Pressable
                onPress={() => router.back()}
                style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
              >
                <Text style={styles.secondaryText}>Done</Text>
              </Pressable>
            </>
          )}

          {/* ── b5 · failed, refunding ────────────────────────────────────── */}
          {!mainnetOnly && step === 'failed' && (
            <>
              <View style={styles.card}>
                <Text style={styles.question}>Payment failed</Text>
                <Text style={styles.hint}>{copy.failedHint(formattedSpent)}</Text>
              </View>

              <View style={styles.card}>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>{copy.failedReasonLabel}</Text>
                  <Text style={styles.rowValue}>—</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Refund on its way back</Text>
                  <Text style={styles.rowValue}>Usually a few minutes</Text>
                </View>
              </View>

              <Text style={styles.hint}>
                Nothing for you to do. It returns to this wallet and will show in your activity.
              </Text>

              <Pressable
                onPress={() => {
                  setStep('form');
                  setOrderId(null);
                  setPayHash(null);
                  setError(null);
                  onClearFieldError?.();
                  void loadRate();
                }}
                style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
              >
                <Text style={styles.primaryText}>Try again</Text>
              </Pressable>
              <Pressable
                onPress={() => router.back()}
                style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
              >
                <Text style={styles.secondaryText}>Back to home</Text>
              </Pressable>
              {orderId ? (
                <Text style={styles.centeredHint}>Ref {orderId.slice(0, 8).toUpperCase()}</Text>
              ) : null}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function createBillFlowStyles(colors: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    flex: { flex: 1 },
    header: { paddingHorizontal: 20, paddingTop: 16 },
    body: { padding: 20, paddingBottom: 60, gap: 16 },

    progressRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
    progressTrack: {
      flex: 1,
      flexDirection: 'row',
      height: 3,
      borderRadius: 2,
      backgroundColor: colors.border,
    },
    progressFill: { backgroundColor: colors.accent, borderRadius: 2 },
    progressLabel: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 12 },

    card: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 16,
      padding: 16,
      gap: 8,
    },
    noteCard: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 16,
      padding: 16,
      backgroundColor: colors.surface,
    },
    errorCard: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.danger,
      borderRadius: 12,
      padding: 12,
      backgroundColor: colors.dangerSurface,
    },
    errorText: { color: colors.danger, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },

    eyebrow: {
      color: colors.textMuted,
      fontFamily: fontFamily.accent,
      fontSize: 11,
      letterSpacing: 0.8,
    },
    question: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 20 },
    hint: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },
    centeredHint: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 13,
      textAlign: 'center',
    },
    money: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 28 },

    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 4,
      gap: 12,
    },
    rowLabel: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13, flexShrink: 1 },
    rowValue: { color: colors.textPrimary, fontFamily: fontFamily.body, fontSize: 13 },
    rowValueStrong: {
      color: colors.textPrimary,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
    },

    field: { gap: 6 },
    label: {
      color: colors.textMuted,
      fontFamily: fontFamily.accent,
      fontSize: 11,
      letterSpacing: 0.8,
    },
    phoneRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingTop: 8,
      paddingBottom: 10,
      borderBottomWidth: 1.5,
      borderBottomColor: colors.accent,
    },
    phoneInput: {
      flex: 1,
      minWidth: 0,
      padding: 0,
      color: colors.textStrong,
      fontFamily: fontFamily.address,
      fontSize: 21,
      letterSpacing: 0.8,
    },
    contactBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    input: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      color: colors.textPrimary,
      fontFamily: fontFamily.body,
      fontSize: 16,
    },

    networkRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
    networkChip: {
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    networkChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    networkText: { color: colors.textMuted, fontFamily: fontFamily.bodySemiBold, fontSize: 13 },
    networkTextActive: { color: colors.onAccent },

    amountRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    currency: { color: colors.textMuted, fontFamily: fontFamily.heading, fontSize: 30 },
    amountInput: {
      flex: 1,
      color: colors.textStrong,
      fontFamily: fontFamily.heading,
      fontSize: 34,
      paddingVertical: 4,
    },

    quickRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
    quickChip: {
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    quickText: { color: colors.textPrimary, fontFamily: fontFamily.body, fontSize: 13 },

    segment: { flexDirection: 'row', gap: 8 },
    segmentItem: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: 10,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    segmentActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    segmentText: { color: colors.textMuted, fontFamily: fontFamily.bodySemiBold, fontSize: 14 },
    segmentTextActive: { color: colors.onAccent },

    waitRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      justifyContent: 'center',
      paddingVertical: 8,
    },

    primaryBtn: {
      backgroundColor: colors.accent,
      borderRadius: 999,
      paddingVertical: 16,
      alignItems: 'center',
    },
    primaryText: { color: colors.onAccent, fontFamily: fontFamily.bodySemiBold, fontSize: 16 },
    secondaryBtn: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 999,
      paddingVertical: 16,
      alignItems: 'center',
    },
    secondaryText: { color: colors.textPrimary, fontFamily: fontFamily.bodySemiBold, fontSize: 16 },
    linkText: {
      color: colors.accent,
      fontFamily: fontFamily.body,
      fontSize: 13,
      paddingTop: 6,
      textAlign: 'center',
    },

    disabled: { opacity: 0.4 },
    pressed: { opacity: 0.85 },
  });
}
