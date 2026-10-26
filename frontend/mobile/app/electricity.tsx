/**
 * Pay electricity bills (prepaid tokens & postpaid) with crypto from this wallet.
 *
 * ## Why electricity has the strictest controls of any bill
 *
 * Electricity is the category where a typo costs the most:
 *   - The user enters a meter number belonging to a distribution company (disco).
 *   - Prepaid meters answer with a 20-digit token the customer keys into the meter.
 *   - Paying the wrong meter credits a stranger's electricity, and there is no reversal.
 *
 * Therefore:
 *   1. The meter MUST be verified before taking any money.
 *   2. The verified customer name MUST be shown before any spend.
 *   3. The user MUST explicitly confirm the name before the passkey prompt.
 *   4. An unverifiable meter blocks the purchase rather than proceeding.
 *   5. The prepaid token must be surfaced prominently on success, copyable, and
 *      persisted to the order record so it survives leaving the screen.
 *   6. previewSpendFee is shown before the passkey prompt — a fee discovered
 *      afterwards is a surprise, not a fee.
 *   7. A polling timeout resolves to "unconfirmed", never "failed", because the user's
 *      crypto has already left the wallet. Telling them it failed invites double-payment.
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
import * as Clipboard from 'expo-clipboard';

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
  getOnrampRate,
  isNairaVerified,
  payBill,
  verifyMeter,
  type MeterVerification,
  type NairaCoin,
} from '../lib/onramp';
import {
  getBillOrders,
  saveBillOrder,
  type PersistedBillOrder,
} from '../lib/billOrders';
import { CheckIcon, CopyIcon } from '../components/icons';

export type Step = 'form' | 'confirm' | 'paying' | 'done' | 'failed' | 'unconfirmed';

export type MeterType = 'prepaid' | 'postpaid';

export type VerificationState = 'idle' | 'verifying' | 'verified' | 'failed';

export interface DiscoInfo {
  id: string;
  name: string;
  shortName: string;
}

export const DISCOS: DiscoInfo[] = [
  { id: 'IKEDC', name: 'Ikeja Electric', shortName: 'Ikeja' },
  { id: 'EKEDC', name: 'Eko Electricity', shortName: 'Eko' },
  { id: 'AEDC', name: 'Abuja Electricity', shortName: 'Abuja' },
  { id: 'IBEDC', name: 'Ibadan Electricity', shortName: 'Ibadan' },
  { id: 'EEDC', name: 'Enugu Electricity', shortName: 'Enugu' },
  { id: 'PHED', name: 'Port Harcourt Electricity', shortName: 'PHED' },
  { id: 'KEDCO', name: 'Kano Electricity', shortName: 'Kano' },
  { id: 'JED', name: 'Jos Electricity', shortName: 'Jos' },
  { id: 'KAEDCO', name: 'Kaduna Electricity', shortName: 'Kaduna' },
  { id: 'BEDC', name: 'Benin Electricity', shortName: 'Benin' },
  { id: 'YEDC', name: 'Yola Electricity', shortName: 'Yola' },
];

export const QUICK_AMOUNTS = [1000, 2000, 5000, 10000];

export function naira(n: number): string {
  return `₦${n.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}

export function formatToken(token: string): string {
  const digits = token.replace(/\D/g, '');
  if (digits.length === 20) {
    return `${digits.slice(0, 4)} - ${digits.slice(4, 8)} - ${digits.slice(8, 12)} - ${digits.slice(12, 16)} - ${digits.slice(16, 20)}`;
  }
  return token;
}

export default function ElectricityScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { wallet } = useWallet();

  const { networkName } = useNetwork();
  const mainnetOnly = networkName !== 'mainnet';

  const [step, setStep] = useState<Step>('form');
  const [error, setError] = useState<string | null>(null);

  // Form State
  const [provider, setProvider] = useState<string>('IKEDC');
  const [meterType, setMeterType] = useState<MeterType>('prepaid');
  const [meterNumber, setMeterNumber] = useState('');
  const [amountNGN, setAmountNGN] = useState('');
  const [coin, setCoin] = useState<NairaCoin>('usdc');

  // Verification State
  const [verificationState, setVerificationState] = useState<VerificationState>('idle');
  const [verifiedCustomer, setVerifiedCustomer] = useState<MeterVerification | null>(null);
  const [verificationError, setVerificationError] = useState<string | null>(null);

  // Rate & Account State
  const [rate, setRate] = useState<number | null>(null);
  const [rateState, setRateState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [customerRef, setCustomerRef] = useState<string | null>(null);
  const [refundAddress, setRefundAddress] = useState<string | null>(null);

  // Confirmation Step Requirement: Explicit confirmation of customer name before passkey
  const [isNameConfirmed, setIsNameConfirmed] = useState(false);

  // Payment Execution State
  const [orderId, setOrderId] = useState<string | null>(null);
  const [payHash, setPayHash] = useState<string | null>(null);
  const [veilFee, setVeilFee] = useState<PlatformFee | null>(null);
  const [spent, setSpent] = useState<number | null>(null);
  const [waitingForPasskey, setWaitingForPasskey] = useState(false);

  // Success / Token State
  const [prepaidToken, setPrepaidToken] = useState<string | null>(null);
  const [unitsCredited, setUnitsCredited] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState(false);

  // Retrievable Past Orders
  const [pastOrders, setPastOrders] = useState<PersistedBillOrder[]>([]);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);
  const MAX_POLL_ATTEMPTS = 15; // 15 attempts * 10s = 150s

  // Load account addresses & past orders on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [addr, ref, orders] = await Promise.all([
        getFeePayerAddress().catch(() => null),
        getCustomerRef().catch(() => null),
        getBillOrders('electricity').catch(() => []),
      ]);
      if (cancelled) return;
      setRefundAddress(addr);
      setCustomerRef(ref);
      setPastOrders(orders);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshPastOrders = useCallback(async () => {
    try {
      const orders = await getBillOrders('electricity');
      setPastOrders(orders);
    } catch {
      // ignore read error
    }
  }, []);

  // Fetch exchange rate per coin
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

  const cleanMeterDigits = meterNumber.replace(/\D/g, '');
  const isMeterFormatValid = cleanMeterDigits.length >= 10 && cleanMeterDigits.length <= 13;

  // Meter Verification action
  const handleVerifyMeter = useCallback(async () => {
    if (!isMeterFormatValid) {
      setVerificationState('failed');
      setVerificationError('Meter number must be between 10 and 13 digits.');
      return;
    }

    setVerificationState('verifying');
    setVerificationError(null);
    setVerifiedCustomer(null);
    setIsNameConfirmed(false);

    try {
      const res = await verifyMeter({
        disco: provider,
        meterNumber: cleanMeterDigits,
        meterType,
        customerRef: customerRef ?? undefined,
      });

      if (res && res.valid && (res.customerName || res.accountHolderName)) {
        setVerifiedCustomer(res);
        setVerificationState('verified');
        setVerificationError(null);
      } else {
        setVerificationState('failed');
        setVerificationError(
          res.error ??
            `Unable to verify meter with ${provider}. Please confirm the meter number and distribution company.`,
        );
      }
    } catch (err) {
      setVerificationState('failed');
      setVerificationError(
        errorMessage(err) ||
          `Could not reach ${provider} to verify this meter. Check your connection or provider status.`,
      );
    }
  }, [isMeterFormatValid, cleanMeterDigits, provider, meterType, customerRef]);

  // Reset verification when meter number, disco, or meter type changes
  const onMeterNumberChange = (text: string) => {
    setMeterNumber(text.replace(/[^\d]/g, '').slice(0, 13));
    setVerificationState('idle');
    setVerifiedCustomer(null);
    setVerificationError(null);
    setIsNameConfirmed(false);
  };

  const onProviderChange = (discoId: string) => {
    setProvider(discoId);
    setVerificationState('idle');
    setVerifiedCustomer(null);
    setVerificationError(null);
    setIsNameConfirmed(false);
  };

  const onMeterTypeChange = (type: MeterType) => {
    setMeterType(type);
    setVerificationState('idle');
    setVerifiedCustomer(null);
    setVerificationError(null);
    setIsNameConfirmed(false);
  };

  const ngn = Number(amountNGN.replace(/[^\d]/g, '')) || 0;
  const code = coin.toUpperCase();
  const cost = rate && ngn > 0 ? ngn / rate : 0;

  // Preview platform fee on confirm step before passkey prompt
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

  // Status Polling on paying step
  useEffect(() => {
    if (!orderId || !customerRef || step !== 'paying' || !payHash) return;
    pollCountRef.current = 0;

    const check = async () => {
      pollCountRef.current += 1;
      try {
        const s = await getBillStatus(customerRef, orderId);
        const token = s.token ?? s.prepaidToken;
        const units = s.units;

        if (/complete|success|delivered/i.test(s.status)) {
          if (token) setPrepaidToken(token);
          if (units) setUnitsCredited(units);

          // The token must survive leaving the screen. Put it where the order record is.
          await saveBillOrder({
            orderId,
            customerRef,
            category: 'electricity',
            provider,
            identifier: cleanMeterDigits,
            amount: ngn,
            amountCrypto: spent ?? cost,
            asset: coin,
            status: 'completed',
            token: token ?? undefined,
            units: units ?? undefined,
            meterType,
            customerName: verifiedCustomer?.customerName ?? verifiedCustomer?.accountHolderName,
            time: Date.now(),
          });
          void refreshPastOrders();

          setStep('done');
          return;
        }

        if (/fail|refund|revers/i.test(s.status)) {
          await saveBillOrder({
            orderId,
            customerRef,
            category: 'electricity',
            provider,
            identifier: cleanMeterDigits,
            amount: ngn,
            amountCrypto: spent ?? cost,
            asset: coin,
            status: 'failed',
            meterType,
            time: Date.now(),
          });
          void refreshPastOrders();

          setStep('failed');
          return;
        }

        // Bounded polling: if attempts exhausted, transition to unconfirmed state
        if (pollCountRef.current >= MAX_POLL_ATTEMPTS) {
          await saveBillOrder({
            orderId,
            customerRef,
            category: 'electricity',
            provider,
            identifier: cleanMeterDigits,
            amount: ngn,
            amountCrypto: spent ?? cost,
            asset: coin,
            status: 'unconfirmed',
            meterType,
            time: Date.now(),
          });
          void refreshPastOrders();

          setStep('unconfirmed');
        }
      } catch (err) {
        // Silent to user during poll: funds already sent, network error is not payment failure
        console.warn('[electricity] status poll failed:', errorMessage(err));
      }
    };

    void check();
    pollRef.current = setInterval(check, 10_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [
    orderId,
    customerRef,
    step,
    payHash,
    cleanMeterDigits,
    provider,
    ngn,
    spent,
    cost,
    coin,
    meterType,
    verifiedCustomer,
    refreshPastOrders,
  ]);

  // Navigation from Form: Verify meter must be confirmed first
  const continueFromForm = useCallback(async () => {
    // An unverifiable meter blocks the purchase rather than proceeding
    if (verificationState !== 'verified' || !verifiedCustomer) {
      setError('You must verify your meter before proceeding.');
      return;
    }

    if (await isNairaVerified()) {
      setError(null);
      setStep('confirm');
      return;
    }

    router.push({
      pathname: '/verify',
      params: {
        returnTo: '/electricity',
        label: 'Electricity',
        summary: `Electricity · ₦${ngn.toLocaleString('en-NG')} to ${cleanMeterDigits} (${provider})`,
      },
    });
  }, [router, verificationState, verifiedCustomer, ngn, cleanMeterDigits, provider]);

  // Payment Execution
  const pay = useCallback(async () => {
    if (!customerRef || !refundAddress || !rate || !verifiedCustomer || !isNameConfirmed) {
      return;
    }
    setStep('paying');
    setError(null);

    try {
      const amountStableCoin = Number((ngn / rate).toFixed(7));

      // 1. Reserve the order first
      const order = await payBill({
        customerRef,
        billCategory: 'electricity',
        provider,
        customerId: cleanMeterDigits,
        amountNgn: ngn,
        amountStableCoin,
        rate,
        coin,
        refundAddress,
      });

      setOrderId(order.id);
      setSpent(amountStableCoin);

      // Save initial pending order
      await saveBillOrder({
        orderId: order.id,
        customerRef,
        category: 'electricity',
        provider,
        identifier: cleanMeterDigits,
        amount: ngn,
        amountCrypto: amountStableCoin,
        asset: coin,
        status: 'pending',
        meterType,
        customerName: verifiedCustomer.customerName ?? verifiedCustomer.accountHolderName,
        time: Date.now(),
      });
      void refreshPastOrders();

      // 2. Spend with passkey
      setWaitingForPasskey(true);
      const issuer = coin === 'usdc' ? getAssetIssuer('USDC', 'mainnet') : null;
      const hash = await spendAsset({
        to: order.wallet,
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
          `This wallet holds ${err.available.toLocaleString('en-US', { maximumFractionDigits: 7 })} ${code}, less than this electricity payment needs.`,
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
    verifiedCustomer,
    isNameConfirmed,
    ngn,
    provider,
    cleanMeterDigits,
    coin,
    wallet.deploy,
    code,
    meterType,
    refreshPastOrders,
  ]);

  const copyToClipboard = async (tok: string) => {
    await Clipboard.setStringAsync(tok);
    setCopiedToken(true);
    setTimeout(() => setCopiedToken(false), 2000);
  };

  const stepNumber = step === 'form' ? 1 : 2;
  const verifiedName = verifiedCustomer?.customerName ?? verifiedCustomer?.accountHolderName;
  const activeDisco = DISCOS.find((d) => d.id === provider) ?? DISCOS[0];

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <FlowHeader title="Electricity" />
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
              <Text style={styles.question}>Switch to mainnet to pay electricity</Text>
              <Text style={styles.hint}>
                Electricity is vended against real crypto, so this only works on mainnet — there is
                no test mode. Switch network in Settings, then come back.
              </Text>
            </View>
          ) : null}

          {error ? (
            <View style={styles.errorCard}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {/* ── Step 1: Form ──────────────────────────────────────────────── */}
          {!mainnetOnly && step === 'form' && (
            <>
              {/* Distribution Company (Disco) Selector */}
              <Text style={styles.label}>DISTRIBUTION COMPANY (DISCO)</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.discoRow}
              >
                {DISCOS.map((d) => (
                  <Pressable
                    key={d.id}
                    onPress={() => onProviderChange(d.id)}
                    style={[styles.discoChip, provider === d.id && styles.discoChipActive]}
                  >
                    <Text
                      style={[styles.discoText, provider === d.id && styles.discoTextActive]}
                    >
                      {d.shortName}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
              <Text style={styles.subHint}>{activeDisco.name} selected</Text>

              {/* Meter Type Segment */}
              <Text style={styles.label}>METER TYPE</Text>
              <View style={styles.segment}>
                {(['prepaid', 'postpaid'] as MeterType[]).map((t) => (
                  <Pressable
                    key={t}
                    onPress={() => onMeterTypeChange(t)}
                    style={[styles.segmentItem, meterType === t && styles.segmentActive]}
                  >
                    <Text
                      style={[
                        styles.segmentText,
                        meterType === t && styles.segmentTextActive,
                      ]}
                    >
                      {t.toUpperCase()}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {/* Meter Number Field & Verification Action */}
              <View style={styles.field}>
                <Text style={styles.label}>METER NUMBER</Text>
                <View style={styles.meterInputRow}>
                  <TextInput
                    testID="meter-input"
                    style={styles.meterInput}
                    value={meterNumber}
                    onChangeText={onMeterNumberChange}
                    keyboardType="number-pad"
                    placeholder="0142 5678 9012"
                    placeholderTextColor={colors.textMuted}
                    maxLength={13}
                  />
                  <Pressable
                    testID="verify-meter-button"
                    onPress={() => void handleVerifyMeter()}
                    disabled={!isMeterFormatValid || verificationState === 'verifying'}
                    style={({ pressed }) => [
                      styles.verifyBtn,
                      (!isMeterFormatValid || verificationState === 'verifying') &&
                        styles.disabled,
                      pressed && styles.pressed,
                    ]}
                  >
                    {verificationState === 'verifying' ? (
                      <ActivityIndicator size="small" color={colors.background} />
                    ) : (
                      <Text style={styles.verifyBtnText}>Verify</Text>
                    )}
                  </Pressable>
                </View>
                <Text style={styles.hint}>
                  Enter the 10–13 digit meter number printed on your meter or electricity card.
                </Text>
              </View>

              {/* Verification Feedback: Customer Name or Verification Failure */}
              {verificationState === 'verified' && verifiedCustomer && (
                <View testID="meter-verified-card" style={styles.verifiedCard}>
                  <View style={styles.verifiedHeader}>
                    <CheckIcon size={18} color={colors.positive} />
                    <Text style={styles.verifiedTitle}>Meter Verified</Text>
                  </View>
                  <Text style={styles.verifiedName}>{verifiedName}</Text>
                  {verifiedCustomer.address ? (
                    <Text style={styles.verifiedAddress}>{verifiedCustomer.address}</Text>
                  ) : null}
                  <Text style={styles.verifiedMeta}>
                    {activeDisco.name} · {meterType.toUpperCase()} · {cleanMeterDigits}
                  </Text>
                </View>
              )}

              {verificationState === 'failed' && (
                <View testID="meter-verification-error" style={styles.errorCard}>
                  <Text style={styles.errorTitle}>Verification Failed</Text>
                  <Text style={styles.errorText}>
                    {verificationError ??
                      `Could not verify this meter with ${activeDisco.name}. An unverifiable meter blocks the purchase to prevent loss of funds.`}
                  </Text>
                </View>
              )}

              {/* Amount Entry */}
              <Text style={styles.label}>AMOUNT</Text>
              <View style={styles.amountRow}>
                <Text style={styles.currency}>₦</Text>
                <TextInput
                  testID="amount-input"
                  style={styles.amountInput}
                  value={amountNGN}
                  onChangeText={(t) => setAmountNGN(t.replace(/[^\d]/g, ''))}
                  keyboardType="number-pad"
                  placeholder="0"
                  placeholderTextColor={colors.textMuted}
                />
              </View>

              <View style={styles.quickRow}>
                {QUICK_AMOUNTS.map((q) => (
                  <Pressable
                    key={q}
                    onPress={() => setAmountNGN(String(q))}
                    style={styles.quickChip}
                  >
                    <Text style={styles.quickText}>₦{q.toLocaleString('en-NG')}</Text>
                  </Pressable>
                ))}
              </View>

              {/* Asset Segment: USDC / XLM */}
              <View style={styles.segment}>
                {(['usdc', 'xlm'] as NairaCoin[]).map((c) => (
                  <Pressable
                    key={c}
                    onPress={() => setCoin(c)}
                    style={[styles.segmentItem, coin === c && styles.segmentActive]}
                  >
                    <Text
                      style={[styles.segmentText, coin === c && styles.segmentTextActive]}
                    >
                      {c.toUpperCase()}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {/* Live Cost Card */}
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

              {/* Continue Button: Blocked until meter is verified */}
              <Pressable
                testID="continue-button"
                onPress={() => void continueFromForm()}
                disabled={
                  verificationState !== 'verified' ||
                  ngn <= 0 ||
                  rateState !== 'ready'
                }
                style={({ pressed }) => [
                  styles.primaryBtn,
                  (verificationState !== 'verified' ||
                    ngn <= 0 ||
                    rateState !== 'ready') &&
                    styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.primaryText}>
                  {verificationState !== 'verified'
                    ? 'Verify meter to continue'
                    : 'Continue'}
                </Text>
              </Pressable>

              {/* Retrievable Past Meter Tokens Section */}
              {pastOrders.length > 0 && (
                <View testID="recent-tokens-section" style={styles.pastSection}>
                  <Text style={styles.sectionTitle}>Recent Meter Tokens</Text>
                  <Text style={styles.sectionSubtitle}>
                    Tokens survive leaving the screen and remain copyable here.
                  </Text>
                  {pastOrders.slice(0, 5).map((order) => (
                    <View key={order.orderId} style={styles.pastCard}>
                      <View style={styles.pastHeader}>
                        <Text style={styles.pastProvider}>
                          {order.provider} · {order.identifier}
                        </Text>
                        <Text style={styles.pastAmount}>₦{order.amount.toLocaleString('en-NG')}</Text>
                      </View>
                      {order.customerName ? (
                        <Text style={styles.pastCustomer}>{order.customerName}</Text>
                      ) : null}
                      {order.token ? (
                        <View style={styles.pastTokenRow}>
                          <Text style={styles.pastTokenText}>{formatToken(order.token)}</Text>
                          <Pressable
                            onPress={() => void copyToClipboard(order.token!)}
                            hitSlop={8}
                            style={styles.pastCopyBtn}
                          >
                            <CopyIcon size={14} color={colors.accent} />
                            <Text style={styles.pastCopyText}>Copy</Text>
                          </Pressable>
                        </View>
                      ) : (
                        <Text style={styles.pastStatus}>{order.status.toUpperCase()}</Text>
                      )}
                    </View>
                  ))}
                </View>
              )}
            </>
          )}

          {/* ── Step 2: Confirm ───────────────────────────────────────────── */}
          {!mainnetOnly && step === 'confirm' && (
            <>
              <View style={styles.card}>
                <Text style={styles.question}>
                  {naira(ngn)} electricity to {cleanMeterDigits} costs
                </Text>
                <Text style={styles.money}>
                  {cost.toFixed(coin === 'xlm' ? 4 : 2)} {code}
                </Text>
              </View>

              <View style={styles.card}>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Customer</Text>
                  <Text style={styles.rowValueStrong}>{verifiedName}</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Provider</Text>
                  <Text style={styles.rowValue}>{activeDisco.name}</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Meter Number</Text>
                  <Text style={styles.rowValue}>{cleanMeterDigits}</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Meter Type</Text>
                  <Text style={styles.rowValue}>{meterType.toUpperCase()}</Text>
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

              {/* Name Confirmation Requirement */}
              <View style={styles.confirmationCard}>
                <Text style={styles.confirmationTitle}>Confirm Customer Name</Text>
                <Text style={styles.confirmationDesc}>
                  Paying the wrong meter credits a stranger&apos;s electricity and cannot be
                  reversed. Confirm this is your meter before spending.
                </Text>
                <Pressable
                  testID="confirm-customer-name-checkbox"
                  onPress={() => setIsNameConfirmed((prev) => !prev)}
                  style={styles.checkboxRow}
                >
                  <View
                    style={[
                      styles.checkbox,
                      isNameConfirmed && styles.checkboxChecked,
                    ]}
                  >
                    {isNameConfirmed && <CheckIcon size={14} color={colors.onAccent} />}
                  </View>
                  <Text style={styles.checkboxLabel}>
                    I confirm this meter belongs to <Text style={styles.bold}>{verifiedName}</Text>
                  </Text>
                </Pressable>
              </View>

              <View style={styles.noteCard}>
                <Text style={styles.hint}>
                  If {activeDisco.name} cannot vend the token, the full amount comes straight back
                  to this wallet.
                </Text>
              </View>

              {/* SlideToConfirm is gated on explicit name confirmation */}
              {isNameConfirmed ? (
                <>
                  <SlideToConfirm label="Slide to pay" onConfirm={() => void pay()} />
                  <Text style={styles.centeredHint}>Then confirm with your passkey</Text>
                </>
              ) : (
                <View testID="locked-confirm-card" style={styles.lockedConfirmCard}>
                  <Text style={styles.lockedConfirmText}>
                    Confirm customer name above to unlock payment
                  </Text>
                </View>
              )}

              <Pressable onPress={() => setStep('form')}>
                <Text style={styles.linkText}>Back</Text>
              </Pressable>
            </>
          )}

          {/* ── Step 3: Paying / In-Flight ─────────────────────────────────── */}
          {!mainnetOnly && step === 'paying' && (
            <>
              <View style={styles.card}>
                <Text style={styles.question}>
                  {waitingForPasskey ? 'Confirm with your passkey' : 'Generating your token'}
                </Text>
                <Text style={styles.hint}>
                  {waitingForPasskey
                    ? 'Face ID, fingerprint or device PIN, whichever this phone uses.'
                    : `${activeDisco.name} is vending ${naira(ngn)} electricity to meter ${cleanMeterDigits}.`}
                </Text>
              </View>

              <View style={styles.card}>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Customer</Text>
                  <Text style={styles.rowValue}>{verifiedName}</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Electricity</Text>
                  <Text style={styles.rowValue}>
                    {naira(ngn)} · {provider} {cleanMeterDigits}
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
                  {waitingForPasskey ? 'Waiting for your passkey…' : 'Waiting for the token…'}
                </Text>
              </View>
            </>
          )}

          {/* ── Step 4: Done / Success with Prominent Token ────────────────── */}
          {!mainnetOnly && step === 'done' && (
            <>
              <View style={styles.card}>
                <Text style={styles.question}>
                  {meterType === 'prepaid' ? 'Electricity token ready' : 'Electricity bill paid'}
                </Text>
                <Text style={styles.hint}>
                  {meterType === 'prepaid'
                    ? 'Enter this token on your meter to credit your electricity.'
                    : `${naira(ngn)} was successfully credited to account ${cleanMeterDigits}.`}
                </Text>
              </View>

              {/* Prominent Prepaid Token Surface */}
              {prepaidToken ? (
                <View testID="prepaid-token-card" style={styles.tokenCard}>
                  <Text style={styles.tokenEyebrow}>PREPAID METER TOKEN</Text>
                  <Text testID="prepaid-token-display" style={styles.tokenDisplay} selectable>
                    {formatToken(prepaidToken)}
                  </Text>

                  <Pressable
                    testID="copy-token-button"
                    onPress={() => void copyToClipboard(prepaidToken)}
                    style={({ pressed }) => [
                      styles.copyBtn,
                      copiedToken && styles.copiedBtn,
                      pressed && styles.pressed,
                    ]}
                  >
                    {copiedToken ? (
                      <>
                        <CheckIcon size={16} color={colors.onAccent} />
                        <Text style={styles.copyBtnText}>Copied to clipboard!</Text>
                      </>
                    ) : (
                      <>
                        <CopyIcon size={16} color={colors.onAccent} />
                        <Text style={styles.copyBtnText}>Copy Token</Text>
                      </>
                    )}
                  </Pressable>

                  {unitsCredited ? (
                    <View style={styles.unitsBadge}>
                      <Text style={styles.unitsText}>Units: {unitsCredited}</Text>
                    </View>
                  ) : null}

                  <View style={styles.tokenInstructions}>
                    <Text style={styles.instructionStep}>
                      1. Key this 20-digit token into your meter keypad.
                    </Text>
                    <Text style={styles.instructionStep}>
                      2. Press the Enter or blue button to credit the units.
                    </Text>
                  </View>
                </View>
              ) : null}

              <View style={styles.card}>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Customer</Text>
                  <Text style={styles.rowValue}>{verifiedName}</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Meter</Text>
                  <Text style={styles.rowValue}>
                    {cleanMeterDigits} ({provider})
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
                  setAmountNGN('');
                  setOrderId(null);
                  setPayHash(null);
                  setSpent(null);
                  setPrepaidToken(null);
                  setUnitsCredited(null);
                  setVerificationState('idle');
                  setVerifiedCustomer(null);
                  setIsNameConfirmed(false);
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

          {/* ── Step 5: Failed ────────────────────────────────────────────── */}
          {!mainnetOnly && step === 'failed' && (
            <>
              <View style={styles.card}>
                <Text style={styles.question}>Payment failed</Text>
                <Text style={styles.hint}>
                  Your {(spent ?? cost).toFixed(coin === 'xlm' ? 4 : 2)} {code} is being returned to
                  this wallet. No electricity units were credited to meter {cleanMeterDigits}.
                </Text>
              </View>

              <View style={styles.card}>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>{activeDisco.name} did not vend</Text>
                  <Text style={styles.rowValue}>—</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Refund</Text>
                  <Text style={styles.rowValue}>Returning to wallet</Text>
                </View>
              </View>

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

          {/* ── Step 6: Unconfirmed (Timeout State) ─────────────────────────── */}
          {!mainnetOnly && step === 'unconfirmed' && (
            <>
              <View style={styles.card}>
                <Text style={styles.question}>Payment sent — verifying with {provider}</Text>
                <Text style={styles.hint}>
                  Your {(spent ?? cost).toFixed(coin === 'xlm' ? 4 : 2)} {code} has been deposited.
                  The provider is processing your token, but has not returned confirmation yet.
                </Text>
              </View>

              <View style={styles.noteCard}>
                <Text style={styles.errorTitle}>Do not pay again</Text>
                <Text style={styles.hint}>
                  You have already been charged. Paying again would purchase duplicate electricity.
                  The token will appear in your Recent Meter Tokens as soon as {provider} settles.
                </Text>
              </View>

              <View style={styles.card}>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Meter</Text>
                  <Text style={styles.rowValue}>{cleanMeterDigits}</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Provider</Text>
                  <Text style={styles.rowValue}>{activeDisco.name}</Text>
                </View>
                {orderId ? (
                  <View style={styles.row}>
                    <Text style={styles.rowLabel}>Order Reference</Text>
                    <Text style={styles.rowValueStrong}>{orderId.slice(0, 8).toUpperCase()}</Text>
                  </View>
                ) : null}
              </View>

              <Pressable
                onPress={() => router.back()}
                style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
              >
                <Text style={styles.secondaryText}>Back to home</Text>
              </Pressable>
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
      gap: 4,
    },
    errorTitle: {
      color: colors.danger,
      fontFamily: fontFamily.heading,
      fontSize: 14,
      fontWeight: '600',
    },
    errorText: { color: colors.danger, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },

    eyebrow: {
      color: colors.textMuted,
      fontFamily: fontFamily.accent,
      fontSize: 11,
      letterSpacing: 0.8,
    },
    question: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 20 },
    money: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 28 },
    hint: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },
    subHint: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 12, marginTop: -8 },
    centeredHint: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 13,
      textAlign: 'center',
    },
    bold: { fontWeight: '700', color: colors.textStrong },

    label: {
      color: colors.textMuted,
      fontFamily: fontFamily.accent,
      fontSize: 11,
      letterSpacing: 0.8,
    },

    discoRow: { flexDirection: 'row', gap: 8, paddingVertical: 4 },
    discoChip: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 20,
      paddingHorizontal: 14,
      paddingVertical: 8,
      backgroundColor: colors.surface,
    },
    discoChipActive: {
      borderColor: colors.accent,
      backgroundColor: colors.surface,
    },
    discoText: { color: colors.textSecondary, fontFamily: fontFamily.body, fontSize: 13 },
    discoTextActive: { color: colors.accent, fontWeight: '600' },

    field: { gap: 6 },
    meterInputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      backgroundColor: colors.surface,
      paddingHorizontal: 12,
    },
    meterInput: {
      flex: 1,
      color: colors.textPrimary,
      fontFamily: fontFamily.address,
      fontSize: 16,
      paddingVertical: 12,
    },
    verifyBtn: {
      backgroundColor: colors.accent,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 8,
    },
    verifyBtnText: { color: colors.onAccent, fontFamily: fontFamily.bodySemiBold, fontSize: 13 },

    verifiedCard: {
      borderWidth: 1,
      borderColor: colors.positive,
      borderRadius: 14,
      padding: 14,
      backgroundColor: colors.surface,
      gap: 4,
    },
    verifiedHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    verifiedTitle: {
      color: colors.positive,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 13,
    },
    verifiedName: {
      color: colors.textStrong,
      fontFamily: fontFamily.heading,
      fontSize: 16,
    },
    verifiedAddress: { color: colors.textSecondary, fontFamily: fontFamily.body, fontSize: 12 },
    verifiedMeta: { color: colors.textMuted, fontFamily: fontFamily.address, fontSize: 11 },

    amountRow: {
      flexDirection: 'row',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      backgroundColor: colors.surface,
      paddingHorizontal: 14,
    },
    currency: { color: colors.textMuted, fontFamily: fontFamily.address, fontSize: 20, marginRight: 6 },
    amountInput: {
      flex: 1,
      color: colors.textPrimary,
      fontFamily: fontFamily.address,
      fontSize: 22,
      paddingVertical: 12,
    },

    quickRow: { flexDirection: 'row', gap: 8 },
    quickChip: {
      flex: 1,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingVertical: 8,
      alignItems: 'center',
      backgroundColor: colors.surface,
    },
    quickText: { color: colors.textSecondary, fontFamily: fontFamily.address, fontSize: 12 },

    segment: {
      flexDirection: 'row',
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      padding: 3,
      backgroundColor: colors.surface,
    },
    segmentItem: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 8 },
    segmentActive: { backgroundColor: colors.accent },
    segmentText: { color: colors.textSecondary, fontFamily: fontFamily.body, fontSize: 12 },
    segmentTextActive: { color: colors.onAccent, fontWeight: '700' },

    confirmationCard: {
      borderWidth: 1.5,
      borderColor: colors.accent,
      borderRadius: 16,
      padding: 16,
      backgroundColor: colors.surface,
      gap: 8,
    },
    confirmationTitle: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 16 },
    confirmationDesc: { color: colors.textSecondary, fontFamily: fontFamily.body, fontSize: 12, lineHeight: 16 },
    checkboxRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 4 },
    checkbox: {
      width: 22,
      height: 22,
      borderWidth: 1.5,
      borderColor: colors.accent,
      borderRadius: 6,
      alignItems: 'center',
      justifyContent: 'center',
    },
    checkboxChecked: { backgroundColor: colors.accent },
    checkboxLabel: { flex: 1, color: colors.textPrimary, fontFamily: fontFamily.body, fontSize: 13 },

    lockedConfirmCard: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 14,
      padding: 14,
      alignItems: 'center',
      backgroundColor: colors.surface,
    },
    lockedConfirmText: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13 },

    row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4, gap: 12 },
    rowLabel: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13, flexShrink: 1 },
    rowValue: { color: colors.textPrimary, fontFamily: fontFamily.address, fontSize: 13 },
    rowValueStrong: { color: colors.textStrong, fontFamily: fontFamily.bodySemiBold, fontSize: 14 },

    waitRow: { flexDirection: 'row', alignItems: 'center', gap: 10, justifyContent: 'center', padding: 8 },

    // Token Card on Success Screen
    tokenCard: {
      borderWidth: 2,
      borderColor: colors.accent,
      borderRadius: 18,
      padding: 20,
      backgroundColor: colors.surface,
      alignItems: 'center',
      gap: 12,
    },
    tokenEyebrow: {
      color: colors.accent,
      fontFamily: fontFamily.accent,
      fontSize: 12,
      letterSpacing: 1,
    },
    tokenDisplay: {
      color: colors.textStrong,
      fontFamily: fontFamily.address,
      fontSize: 22,
      fontWeight: '700',
      textAlign: 'center',
      letterSpacing: 1.2,
      marginVertical: 4,
    },
    copyBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: colors.accent,
      paddingHorizontal: 20,
      paddingVertical: 10,
      borderRadius: 12,
    },
    copiedBtn: {
      backgroundColor: colors.positive,
    },
    copyBtnText: {
      color: colors.onAccent,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 14,
    },
    unitsBadge: {
      paddingHorizontal: 12,
      paddingVertical: 4,
      borderRadius: 12,
      backgroundColor: 'rgba(255,255,255,0.06)',
    },
    unitsText: {
      color: colors.textMuted,
      fontFamily: fontFamily.address,
      fontSize: 12,
    },
    tokenInstructions: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      paddingTop: 12,
      width: '100%',
      gap: 4,
    },
    instructionStep: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 12,
    },

    primaryBtn: {
      backgroundColor: colors.accent,
      borderRadius: 14,
      paddingVertical: 14,
      alignItems: 'center',
    },
    primaryText: { color: colors.onAccent, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },
    secondaryBtn: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 14,
      paddingVertical: 14,
      alignItems: 'center',
    },
    secondaryText: { color: colors.textPrimary, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },
    disabled: { opacity: 0.4 },
    pressed: { opacity: 0.8 },
    linkText: { color: colors.accent, fontFamily: fontFamily.bodyMedium, fontSize: 13, textAlign: 'center' },

    // Past Orders Section
    pastSection: { marginTop: 12, gap: 10 },
    sectionTitle: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 16 },
    sectionSubtitle: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 12, marginTop: -4 },
    pastCard: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 14,
      padding: 12,
      backgroundColor: colors.surface,
      gap: 6,
    },
    pastHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    pastProvider: { color: colors.textStrong, fontFamily: fontFamily.bodySemiBold, fontSize: 13 },
    pastAmount: { color: colors.accent, fontFamily: fontFamily.address, fontSize: 13 },
    pastCustomer: { color: colors.textSecondary, fontFamily: fontFamily.body, fontSize: 12 },
    pastTokenRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      backgroundColor: 'rgba(255, 255, 255, 0.04)',
      paddingHorizontal: 8,
      paddingVertical: 6,
      borderRadius: 8,
    },
    pastTokenText: { color: colors.textPrimary, fontFamily: fontFamily.address, fontSize: 12 },
    pastCopyBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    pastCopyText: { color: colors.accent, fontFamily: fontFamily.bodyMedium, fontSize: 11 },
    pastStatus: { color: colors.textMuted, fontFamily: fontFamily.address, fontSize: 11 },
  });
}
