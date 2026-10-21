/**
 * Buy a mobile data bundle with crypto from this wallet.
 *
 * ## Why this is not airtime
 *
 * Airtime is an arbitrary naira amount. A data bundle is a *product* — 1 GB
 * for 30 days, chosen from the operator's own catalogue. The price comes from
 * the selected bundle, not from a free-text field, and showing naira amounts
 * alone tells the user nothing about what they are buying. This screen fetches
 * the bundle list for the chosen operator and lets the user pick by size and
 * validity.
 *
 * ## Same order-of-operations discipline as airtime
 *
 * `payBill` reserves the order and locks the rate before anything is signed.
 * A reservation that fails costs nothing; a spend with no order behind it is
 * money sent to an address that was never expecting it.
 *
 * ## "Empty list" is not a failure
 *
 * An operator with no bundles returns an empty array. The screen says so
 * clearly rather than treating it as an error — the user has done nothing wrong.
 *
 * ## Fee shown before the passkey
 *
 * `previewSpendFee` is called on the confirm step, before the slide-to-pay
 * gesture. A charge a user only finds in their history is a surprise, not a fee.
 *
 * ## Test boundary
 *
 * Linq has no sandbox. Everything is tested against mocks — never against the
 * live provider. See `__tests__/dataScreen.test.tsx`.
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
import { useRouter } from 'expo-router';

import { FlowHeader } from '../components/FlowHeader';
import { SlideToConfirm } from '../components/SlideToConfirm';
import { useWallet } from '../components/WalletProvider';
import { useTheme } from '../hooks/useTheme';
import { useNetwork } from '../hooks/useNetwork';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { errorMessage } from '../lib/errorMessage';
import { getAssetIssuer } from '../lib/assets';
import { getFeePayerAddress } from '../lib/activity';
import { NotEnoughToSend, previewSpendFee, spendAsset } from '../lib/spendAsset';
import type { PlatformFee } from '../lib/platformFee';
import {
  getBillStatus,
  getCustomerRef,
  isNairaVerified,
  getOnrampRate,
  payBill,
  fetchDataBundles,
  type NairaCoin,
  type DataBundle,
} from '../lib/onramp';

type Step = 'form' | 'confirm' | 'paying' | 'done' | 'failed';

/**
 * Nigerian mobile operators — same set as airtime for consistency.
 */
const OPERATORS = ['MTN', 'AIRTEL', 'GLO', '9MOBILE'] as const;
type Operator = (typeof OPERATORS)[number];

/** Phone-number prefixes by operator, for auto-detection. */
const PREFIXES: Record<Operator, string[]> = {
  MTN: ['0803', '0806', '0703', '0706', '0813', '0816', '0810', '0814', '0903', '0906', '0913', '0916'],
  AIRTEL: ['0802', '0808', '0708', '0812', '0701', '0902', '0901', '0904', '0907', '0912'],
  GLO: ['0805', '0807', '0705', '0815', '0811', '0905', '0915'],
  '9MOBILE': ['0809', '0818', '0817', '0909', '0908'],
};

function detectOperator(phone: string): Operator | null {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return null;
  const prefix = digits.slice(0, 4);
  for (const [op, list] of Object.entries(PREFIXES) as [Operator, string[]][]) {
    if (list.includes(prefix)) return op;
  }
  return null;
}

/** Format megabytes as "500 MB" or "1.5 GB" etc. */
function formatSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB`;
  return `${mb} MB`;
}

function naira(n: number): string {
  return `₦${n.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}

export default function DataScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { wallet } = useWallet();

  const { networkName } = useNetwork();
  const mainnetOnly = networkName !== 'mainnet';

  const [step, setStep] = useState<Step>('form');
  const [error, setError] = useState<string | null>(null);

  // Form
  const [operator, setOperator] = useState<Operator>('MTN');
  const [operatorTouched, setOperatorTouched] = useState(false);
  const [phone, setPhone] = useState('');
  const [coin, setCoin] = useState<NairaCoin>('usdc');
  const [selectedBundle, setSelectedBundle] = useState<DataBundle | null>(null);

  // Bundle list
  const [bundles, setBundles] = useState<DataBundle[]>([]);
  const [bundlesState, setBundlesState] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'failed'>('idle');

  // Exchange rate
  const [rate, setRate] = useState<number | null>(null);
  const [rateState, setRateState] = useState<'loading' | 'ready' | 'failed'>('loading');

  // Order
  const [customerRef, setCustomerRef] = useState<string | null>(null);
  const [refundAddress, setRefundAddress] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [payHash, setPayHash] = useState<string | null>(null);
  const [spent, setSpent] = useState<number | null>(null);
  // Shown before the passkey prompt. Null when the Veil smart wallet charges no
  // fee, which is the usual case — it is shown only when there is something
  // to show.
  const [veilFee, setVeilFee] = useState<PlatformFee | null>(null);
  const [waitingForPasskey, setWaitingForPasskey] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Auto-detect operator from phone prefix. The user can override it — numbers
  // are ported, and a ported number sent to the wrong biller fails silently.
  const detected = detectOperator(phone);
  useEffect(() => {
    if (detected && !operatorTouched) setOperator(detected);
  }, [detected, operatorTouched]);

  // Resolve the fee-payer address (refund target) and stable customer reference
  // once on mount. Neither changes within a session.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [addr, ref] = await Promise.all([
        getFeePayerAddress().catch(() => null),
        getCustomerRef().catch(() => null),
      ]);
      if (!cancelled) {
        setRefundAddress(addr);
        setCustomerRef(ref);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Fetch exchange rate whenever the coin selection changes. Rate is per coin
  // (XLM ≠ USDC), so switching the toggle must re-fetch rather than reuse.
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

  useEffect(() => { void loadRate(); }, [loadRate]);

  // Fetch bundle catalogue whenever the chosen operator changes.
  const loadBundles = useCallback(async (op: Operator) => {
    if (mainnetOnly) return;
    setBundlesState('loading');
    setBundles([]);
    setSelectedBundle(null);
    try {
      const result = await fetchDataBundles(op);
      if (result.length === 0) {
        setBundlesState('empty');
      } else {
        setBundles(result);
        setBundlesState('ready');
      }
    } catch {
      setBundlesState('failed');
    }
  }, [mainnetOnly]);

  useEffect(() => { void loadBundles(operator); }, [loadBundles, operator]);

  // Poll the vend result. Unlike the onramp, nothing on-chain says whether the
  // bundle activated — asking the status endpoint is the only way to know.
  useEffect(() => {
    if (!orderId || !customerRef || step !== 'paying' || !payHash) return;
    const check = async () => {
      try {
        const s = await getBillStatus(customerRef, orderId);
        if (/complete|success|delivered/i.test(s.status)) setStep('done');
        if (/fail|refund|revers/i.test(s.status)) setStep('failed');
      } catch (err) {
        // Silent to the user: a failed poll is not actionable, and the payment
        // has already left — an error here reads as if it had not, which risks
        // a double-spend.
        console.warn('[data] status poll failed:', errorMessage(err));
      }
    };
    void check();
    pollRef.current = setInterval(check, 10_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [orderId, customerRef, step, payHash]);

  // Derived
  const code = coin.toUpperCase();
  const amountNgn = selectedBundle?.amountNgn ?? 0;
  const cost = rate && amountNgn > 0 ? amountNgn / rate : 0;
  const phoneDigits = phone.replace(/\D/g, '');
  const phoneValid = phoneDigits.length === 11 && phoneDigits.startsWith('0');

  // Preview the Veil platform fee on the confirm step — only then, and only
  // when there is a real cost to compute. Reading balances on every keystroke
  // would be a request per digit.
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
    return () => { cancelled = true; };
  }, [step, cost, coin]);

  // KYC gate: check before advancing to confirm. If not verified, redirect to
  // /verify with enough context to return to this screen after.
  const continueFromForm = useCallback(async () => {
    if (await isNairaVerified()) {
      setStep('confirm');
      return;
    }
    router.push({
      pathname: '/verify',
      params: {
        returnTo: '/data',
        label: 'Data',
        summary: `Data · ${selectedBundle?.label ?? ''} to ${phone}`,
      },
    });
  }, [router, selectedBundle, phone]);

  // Reserve the order, then spend. Reserve first — a failed reservation costs
  // nothing; a spend with no order behind it is money sent into a void.
  const pay = useCallback(async () => {
    if (!customerRef || !refundAddress || !rate || !selectedBundle) return;
    setStep('paying');
    setError(null);
    try {
      const amountStableCoin = Number((selectedBundle.amountNgn / rate).toFixed(7));
      const order = await payBill({
        customerRef,
        billCategory: 'data',
        provider: operator,
        // customerId is the subscriber, not the product. The bundle id travels
        // alongside it in `bundleId` so Linq still knows which phone to credit.
        customerId: phoneDigits,
        // Never elide or abbreviate the provider's product id.
        bundleId: selectedBundle.id,
        amountNgn: selectedBundle.amountNgn,
        amountStableCoin,
        rate,
        coin,
        refundAddress,
      });
      setOrderId(order.id);
      setSpent(amountStableCoin);

      setWaitingForPasskey(true);
      const issuer = coin === 'usdc' ? getAssetIssuer('USDC', 'mainnet') : null;
      const hash = await spendAsset({
        to: order.wallet,
        // From the order, not from the screen: Linq settles at whatever
        // arrives, so an amount that drifted would quietly buy less data.
        amount: String(amountStableCoin),
        ...(issuer ? { asset: { code: 'USDC', issuer } } : {}),
        deploy: wallet.deploy,
      });
      setWaitingForPasskey(false);
      setPayHash(hash);
    } catch (err) {
      setWaitingForPasskey(false);
      if (err instanceof NotEnoughToSend) {
        setError(
          `This wallet holds ${err.available.toLocaleString('en-US', { maximumFractionDigits: 7 })} ${code}, less than this bundle costs.`,
        );
      } else {
        setError(errorMessage(err));
      }
      setStep('confirm');
    }
  }, [customerRef, refundAddress, rate, selectedBundle, operator, phoneDigits, coin, wallet.deploy, code]);

  const stepNumber = step === 'form' ? 1 : 2;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <FlowHeader title="Data" />
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
              <Text style={styles.question}>Switch to mainnet to buy data</Text>
              <Text style={styles.hint}>
                Data bundles are vended against real crypto, so this only works on mainnet — there
                is no test mode. Switch network in Settings, then come back.
              </Text>
            </View>
          ) : null}

          {error ? (
            <View style={styles.errorCard}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {/* ── d1 · form ─────────────────────────────────────────────────── */}
          {!mainnetOnly && step === 'form' && (
            <>
              <Text style={styles.label}>OPERATOR</Text>
              <View style={styles.chipRow}>
                {OPERATORS.map((op) => (
                  <Pressable
                    key={op}
                    onPress={() => {
                      setOperator(op);
                      setOperatorTouched(true);
                    }}
                    style={[styles.chip, operator === op && styles.chipActive]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: operator === op }}
                  >
                    <Text style={[styles.chipText, operator === op && styles.chipTextActive]}>
                      {op}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <View style={styles.field}>
                <Text style={styles.label}>PHONE NUMBER</Text>
                <View style={styles.phoneRow}>
                  <TextInput
                    style={styles.phoneInput}
                    value={phone}
                    onChangeText={(t) => setPhone(t.replace(/[^\d]/g, '').slice(0, 11))}
                    keyboardType="number-pad"
                    placeholder="0803 512 4471"
                    placeholderTextColor={colors.textMuted}
                    testID="phone-input"
                  />
                </View>
                {detected ? (
                  <Text style={styles.hint}>
                    {detected} number, detected from {phoneDigits.slice(0, 4)}
                    {operatorTouched && operator !== detected ? ` — sending to ${operator}` : ''}
                  </Text>
                ) : (
                  <Text style={styles.hint}>
                    Numbers get ported — check the operator above matches.
                  </Text>
                )}
              </View>

              {/* Bundle catalogue ───────────────────────────────────────── */}
              <Text style={styles.label}>BUNDLE</Text>

              {bundlesState === 'loading' && (
                <View style={styles.centeredRow} testID="bundles-loading">
                  <ActivityIndicator color={colors.accent} />
                  <Text style={styles.hint}>Loading bundles…</Text>
                </View>
              )}

              {bundlesState === 'empty' && (
                <View style={styles.card} testID="empty-bundles-notice">
                  <Text style={styles.question}>No bundles available</Text>
                  <Text style={styles.hint}>
                    {operator} has no data bundles configured right now. Try another operator or
                    check back later.
                  </Text>
                </View>
              )}

              {bundlesState === 'failed' && (
                <View style={styles.errorCard} testID="bundles-error">
                  <Text style={styles.errorText}>Could not load bundles.</Text>
                  <Pressable onPress={() => void loadBundles(operator)} hitSlop={8}>
                    <Text style={styles.linkText}>Try again</Text>
                  </Pressable>
                </View>
              )}

              {bundlesState === 'ready' && bundles.map((b) => (
                <Pressable
                  key={b.id}
                  onPress={() => setSelectedBundle(b)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: selectedBundle?.id === b.id }}
                  accessibilityLabel={`${formatSize(b.sizeMb)}, ${b.validityDays} days, ${naira(b.amountNgn)}`}
                  style={({ pressed }) => [
                    styles.bundleRow,
                    selectedBundle?.id === b.id && styles.bundleRowActive,
                    pressed && styles.pressed,
                  ]}
                  testID={`bundle-${b.id}`}
                >
                  <View style={styles.bundleInfo}>
                    <Text
                      style={[styles.bundleSize, selectedBundle?.id === b.id && styles.bundleSizeActive]}
                    >
                      {formatSize(b.sizeMb)}
                    </Text>
                    <Text style={styles.bundleValidity}>
                      {b.validityDays} day{b.validityDays !== 1 ? 's' : ''}
                    </Text>
                  </View>
                  <Text
                    style={[styles.bundlePrice, selectedBundle?.id === b.id && styles.bundlePriceActive]}
                    testID={`bundle-price-${b.id}`}
                  >
                    {naira(b.amountNgn)}
                  </Text>
                </Pressable>
              ))}

              {selectedBundle ? (
                <>
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

                  <View style={styles.card} testID="cost-summary">
                    <View style={styles.row}>
                      <Text style={styles.rowLabel}>Bundle</Text>
                      <Text style={styles.rowValue}>
                        {formatSize(selectedBundle.sizeMb)} · {selectedBundle.validityDays} day{selectedBundle.validityDays !== 1 ? 's' : ''}
                      </Text>
                    </View>
                    <View style={styles.row}>
                      <Text style={styles.rowLabel}>Costs</Text>
                      <Text style={styles.rowValueStrong} testID="cost-value">
                        {rateState === 'ready' && cost > 0
                          ? `${cost.toFixed(coin === 'xlm' ? 4 : 2)} ${code}`
                          : rateState === 'loading'
                            ? 'Checking…'
                            : '—'}
                      </Text>
                    </View>
                    {rateState === 'failed' && (
                      <Pressable onPress={() => void loadRate()}>
                        <Text style={styles.linkText}>Rate unavailable — try again</Text>
                      </Pressable>
                    )}
                  </View>
                </>
              ) : null}

              <Pressable
                onPress={() => void continueFromForm()}
                disabled={!phoneValid || !selectedBundle || rateState !== 'ready'}
                style={({ pressed }) => [
                  styles.primaryBtn,
                  (!phoneValid || !selectedBundle || rateState !== 'ready') && styles.disabled,
                  pressed && styles.pressed,
                ]}
                testID="continue-btn"
              >
                <Text style={styles.primaryText}>Continue</Text>
              </Pressable>
            </>
          )}

          {/* ── d2 · confirm ──────────────────────────────────────────────── */}
          {!mainnetOnly && step === 'confirm' && selectedBundle && (
            <>
              <View style={styles.card}>
                <Text style={styles.question}>
                  {formatSize(selectedBundle.sizeMb)} data for {phoneDigits} costs
                </Text>
                <Text style={styles.money}>
                  {cost.toFixed(coin === 'xlm' ? 4 : 2)} {code}
                </Text>
              </View>

              <View style={styles.card}>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Operator</Text>
                  <Text style={styles.rowValue}>{operator}</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Phone</Text>
                  <Text style={styles.rowValue}>{phoneDigits}</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Bundle</Text>
                  <Text style={styles.rowValue}>
                    {formatSize(selectedBundle.sizeMb)} · {selectedBundle.validityDays} day{selectedBundle.validityDays !== 1 ? 's' : ''}
                  </Text>
                </View>
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
                <Text style={styles.hint}>
                  If {operator} can&apos;t activate the bundle, the full amount comes straight back
                  to this wallet.
                </Text>
              </View>

              <SlideToConfirm label="Slide to pay" onConfirm={() => void pay()} />
              <Text style={styles.centeredHint}>Then confirm with your passkey</Text>

              <Pressable onPress={() => setStep('form')}>
                <Text style={styles.linkText}>Back</Text>
              </Pressable>
            </>
          )}

          {/* ── d3 · passkey / in flight ──────────────────────────────────── */}
          {!mainnetOnly && step === 'paying' && selectedBundle && (
            <>
              <View style={styles.card}>
                <Text style={styles.question}>
                  {waitingForPasskey ? 'Confirm with your passkey' : 'Activating your bundle'}
                </Text>
                <Text style={styles.hint}>
                  {waitingForPasskey
                    ? 'Face ID, fingerprint or device PIN, whichever this phone uses.'
                    : `${operator} is activating ${formatSize(selectedBundle.sizeMb)} on ${phoneDigits}.`}
                </Text>
              </View>

              <View style={styles.card}>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Bundle</Text>
                  <Text style={styles.rowValue}>
                    {formatSize(selectedBundle.sizeMb)} · {operator} {phoneDigits}
                  </Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>You spend</Text>
                  <Text style={styles.rowValue}>
                    {(spent ?? cost).toFixed(coin === 'xlm' ? 4 : 2)} {code}
                  </Text>
                </View>
              </View>

              <View style={styles.waitRow}>
                <ActivityIndicator color={colors.accent} />
                <Text style={styles.hint}>
                  {waitingForPasskey ? 'Waiting for your passkey…' : 'Waiting for activation…'}
                </Text>
              </View>
            </>
          )}

          {/* ── d4 · done ─────────────────────────────────────────────────── */}
          {!mainnetOnly && step === 'done' && selectedBundle && (
            <>
              <View style={styles.card}>
                <Text style={styles.question}>Bundle activated</Text>
                <Text style={styles.hint}>
                  {formatSize(selectedBundle.sizeMb)} is on {phoneDigits}. It usually shows within
                  a minute.
                </Text>
              </View>

              <View style={styles.card}>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Operator</Text>
                  <Text style={styles.rowValue}>{operator}</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Bundle</Text>
                  <Text style={styles.rowValue}>
                    {formatSize(selectedBundle.sizeMb)} · {selectedBundle.validityDays} day{selectedBundle.validityDays !== 1 ? 's' : ''}
                  </Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>You spent</Text>
                  <Text style={styles.rowValue}>
                    {(spent ?? cost).toFixed(coin === 'xlm' ? 4 : 2)} {code}
                  </Text>
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
                  setSelectedBundle(null);
                  setOrderId(null);
                  setPayHash(null);
                  setSpent(null);
                  void loadRate();
                }}
                style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
              >
                <Text style={styles.primaryText}>Buy again</Text>
              </Pressable>
              <Pressable
                onPress={() => router.back()}
                style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
              >
                <Text style={styles.secondaryText}>Done</Text>
              </Pressable>
            </>
          )}

          {/* ── d5 · failed, refunding ────────────────────────────────────── */}
          {!mainnetOnly && step === 'failed' && selectedBundle && (
            <>
              {/*
               * "We could not confirm this" — not "Payment failed".
               *
               * The user's crypto has left. Saying "failed" reads as if it
               * has not, which could push them to pay again — double-spending
               * against an order that may still complete. The wording follows
               * the same discipline as the airtime screen and the issue spec.
               */}
              <View style={styles.card}>
                <Text style={styles.question}>We could not confirm this</Text>
                <Text style={styles.hint}>
                  Your {(spent ?? cost).toFixed(coin === 'xlm' ? 4 : 2)} {code} is being returned
                  to this wallet. No data bundle was activated on {phoneDigits}.
                </Text>
              </View>

              <View style={styles.card}>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>{operator} did not complete the activation</Text>
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

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    flex: { flex: 1 },
    header: { paddingHorizontal: 20, paddingTop: 16 },
    body: { padding: 20, paddingBottom: 60, gap: 16 },

    progressRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
    progressTrack: { flex: 1, flexDirection: 'row', height: 3, borderRadius: 2, backgroundColor: colors.border },
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

    eyebrow: { color: colors.textMuted, fontFamily: fontFamily.accent, fontSize: 11, letterSpacing: 0.8 },
    question: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 20 },
    hint: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },
    centeredHint: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 13,
      textAlign: 'center',
    },
    money: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 28 },

    row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4, gap: 12 },
    rowLabel: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13, flexShrink: 1 },
    rowValue: { color: colors.textPrimary, fontFamily: fontFamily.body, fontSize: 13 },
    rowValueStrong: { color: colors.textPrimary, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },

    field: { gap: 6 },
    label: { color: colors.textMuted, fontFamily: fontFamily.accent, fontSize: 11, letterSpacing: 0.8 },

    phoneRow: {
      paddingTop: 8,
      paddingBottom: 10,
      borderBottomWidth: 1.5,
      borderBottomColor: colors.accent,
    },
    phoneInput: {
      color: colors.textStrong,
      fontFamily: fontFamily.address,
      fontSize: 21,
      letterSpacing: 0.8,
      padding: 0,
    },

    chipRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
    chip: {
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    chipText: { color: colors.textMuted, fontFamily: fontFamily.bodySemiBold, fontSize: 13 },
    chipTextActive: { color: colors.onAccent },

    bundleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 14,
      padding: 14,
      gap: 12,
    },
    bundleRowActive: {
      borderColor: colors.accent,
      backgroundColor: 'rgba(253,218,36,0.06)',
    },
    bundleInfo: { gap: 2 },
    bundleSize: {
      color: colors.textPrimary,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
    },
    bundleSizeActive: { color: colors.accent },
    bundleValidity: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 12 },
    bundlePrice: {
      color: colors.textPrimary,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
    },
    bundlePriceActive: { color: colors.accent },

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

    centeredRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      justifyContent: 'center',
      paddingVertical: 8,
    },
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
    linkText: { color: colors.accent, fontFamily: fontFamily.body, fontSize: 13, paddingTop: 6, textAlign: 'center' },

    disabled: { opacity: 0.4 },
    pressed: { opacity: 0.85 },
  });
}
