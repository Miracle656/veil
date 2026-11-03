/**
 * Buy cable TV subscriptions with crypto from this wallet.
 *
 * Follows the same pattern as airtime: reserve, pay from the wallet,
 * poll to a terminal state.
 *
 * Key differences:
 * - Smartcard lookup shows customer name, current package, and due date before spending
 * - User can choose from available packages
 * - Provider-specific (DSTV, GOtv, etc.)
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
  lookupCableTv,
  type NairaCoin,
  type CableTvLookup,
  classifyBillStatus,
} from '../lib/onramp';
import { BillPoller, MAX_CONSECUTIVE_POLL_ERRORS } from '../lib/billPolling';

type Step = 'form' | 'lookup' | 'confirm' | 'paying' | 'done' | 'failed' | 'unconfirmed';

const PROVIDERS = ['DSTV', 'GOtv', 'StarTimes'];

function naira(n: number): string {
  return `₦${n.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}

export default function CableTvScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { wallet } = useWallet();

  const { networkName } = useNetwork();
  const mainnetOnly = networkName !== 'mainnet';

  const [step, setStep] = useState<Step>('form');
  const [error, setError] = useState<string | null>(null);

  const [provider, setProvider] = useState<string>('DSTV');
  const [smartcard, setSmartcard] = useState('');
  const [selectedPackage, setSelectedPackage] = useState<string | null>(null);
  const [coin, setCoin] = useState<NairaCoin>('usdc');

  const [rate, setRate] = useState<number | null>(null);
  const [rateState, setRateState] = useState<'loading' | 'ready' | 'failed'>('loading');

  const [customerRef, setCustomerRef] = useState<string | null>(null);
  const [refundAddress, setRefundAddress] = useState<string | null>(null);

  const [orderId, setOrderId] = useState<string | null>(null);
  const [payHash, setPayHash] = useState<string | null>(null);
  const [veilFee, setVeilFee] = useState<PlatformFee | null>(null);
  const [spent, setSpent] = useState<number | null>(null);
  const [waitingForPasskey, setWaitingForPasskey] = useState(false);

  const [lookupData, setLookupData] = useState<CableTvLookup | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);

  const pollerRef = useRef<BillPoller | null>(null);
  const [pollErrorCount, setPollErrorCount] = useState(0);
  const [unconfirmedReason, setUnconfirmedReason] = useState<'error' | 'timeout' | null>(null);
  const [isRechecking, setIsRechecking] = useState(false);

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

  useEffect(() => {
    if (!orderId || !customerRef || step !== 'paying' || !payHash) return;

    const poller = new BillPoller(
      customerRef,
      orderId,
      {
        onDone: () => setStep('done'),
        onFailed: () => setStep('failed'),
        onUnconfirmed: (reason) => {
          setUnconfirmedReason(reason);
          setStep('unconfirmed');
        },
        onErrorCountChange: (count) => setPollErrorCount(count),
      },
    );
    pollerRef.current = poller;
    poller.start();

    return () => {
      if (pollerRef.current) {
        pollerRef.current.stop();
        pollerRef.current = null;
      }
    };
  }, [orderId, customerRef, step, payHash]);

  const smartcardDigits = smartcard.replace(/\D/g, '');
  const ngn = selectedPackage && lookupData
    ? lookupData.availablePackages.find(p => p.id === selectedPackage)?.price || 0
    : 0;
  const code = coin.toUpperCase();
  const cost = rate && ngn > 0 ? ngn / rate : 0;

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

  const lookupSmartcard = useCallback(async () => {
    if (!provider || smartcardDigits.length < 6) return;
    setLookupLoading(true);
    setError(null);
    try {
      const data = await lookupCableTv({
        provider,
        smartcardNumber: smartcardDigits,
      });
      setLookupData(data);
      setStep('lookup');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLookupLoading(false);
    }
  }, [provider, smartcardDigits]);

  const continueFromForm = useCallback(async () => {
    if (await isNairaVerified()) {
      await lookupSmartcard();
      return;
    }
    router.push({
      pathname: '/verify',
      params: {
        returnTo: '/cabletv',
        label: 'Cable TV',
        summary: `Cable TV · ${provider}`,
      },
    });
  }, [router, provider, lookupSmartcard]);

  const continueFromLookup = useCallback(() => {
    if (!selectedPackage) return;
    setStep('confirm');
  }, [selectedPackage]);

  const pay = useCallback(async () => {
    if (!customerRef || !refundAddress || !rate || !selectedPackage || !lookupData) return;
    setStep('paying');
    setError(null);
    setPollErrorCount(0);
    setUnconfirmedReason(null);
    try {
      const pkg = lookupData.availablePackages.find(p => p.id === selectedPackage);
      if (!pkg) throw new Error('Selected package not found');

      const amountStableCoin = Number((pkg.price / rate).toFixed(7));
      const order = await payBill({
        customerRef,
        billCategory: 'cabletv',
        provider,
        customerId: smartcardDigits,
        amountNgn: pkg.price,
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
          `This wallet holds ${err.available.toLocaleString('en-US', { maximumFractionDigits: 7 })} ${code}, less than this subscription needs.`,
        );
      } else {
        setError(errorMessage(err));
      }
      setStep('confirm');
    }
  }, [customerRef, refundAddress, rate, selectedPackage, lookupData, provider, smartcardDigits, coin, wallet.deploy, code]);

  // Stop polling on unmount
  useEffect(() => {
    return () => {
      if (pollerRef.current) {
        pollerRef.current.stop();
        pollerRef.current = null;
      }
    };
  }, []);

  const stepNumber = step === 'form' || step === 'lookup' ? 1 : 2;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <FlowHeader title="Cable TV" />
        {!mainnetOnly && (step === 'form' || step === 'lookup' || step === 'confirm') ? (
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
            <Text style={styles.question}>Switch to mainnet to buy cable TV</Text>
            <Text style={styles.hint}>
              Subscriptions are vended against real crypto, so this only works on mainnet — there is
              no test mode. Switch network in Settings, then come back.
            </Text>
          </View>
        ) : null}

        {error ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {/* ── form ─────────────────────────────────────────────────── */}
        {!mainnetOnly && step === 'form' && (
          <>
            <Text style={styles.label}>PROVIDER</Text>
            <View style={styles.networkRow}>
              {PROVIDERS.map((p) => (
                <Pressable
                  key={p}
                  onPress={() => setProvider(p)}
                  style={[styles.networkChip, provider === p && styles.networkChipActive]}
                >
                  <Text style={[styles.networkText, provider === p && styles.networkTextActive]}>
                    {p}
                  </Text>
                </Pressable>
              ))}
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>SMARTCARD NUMBER</Text>
              <TextInput
                style={styles.input}
                value={smartcard}
                onChangeText={(t) => setSmartcard(t.replace(/\D/g, ''))}
                keyboardType="number-pad"
                placeholder="Enter smartcard number"
                placeholderTextColor={colors.textMuted}
              />
              <Text style={styles.hint}>
                Enter the smartcard number shown on your decoder or subscription
              </Text>
            </View>

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

            <Pressable
              onPress={() => void continueFromForm()}
              disabled={smartcardDigits.length < 6 || lookupLoading}
              style={({ pressed }) => [
                styles.primaryBtn,
                (smartcardDigits.length < 6 || lookupLoading) && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.primaryText}>
                {lookupLoading ? 'Looking up...' : 'Continue'}
              </Text>
            </Pressable>
          </>
        )}

        {/* ── lookup results ─────────────────────────────────────────────── */}
        {!mainnetOnly && step === 'lookup' && lookupData && (
          <>
            <View style={styles.card}>
              <Text style={styles.question}>Account found</Text>
              <Text style={styles.hint}>Customer: {lookupData.customerName}</Text>
              <Text style={styles.hint}>Current package: {lookupData.currentPackage}</Text>
              <Text style={styles.hint}>Due date: {lookupData.dueDate}</Text>
            </View>

            <Text style={styles.label}>SELECT PACKAGE</Text>
            <View style={styles.packageList}>
              {lookupData.availablePackages.map((pkg) => (
                <Pressable
                  key={pkg.id}
                  onPress={() => setSelectedPackage(pkg.id)}
                  style={[
                    styles.packageCard,
                    selectedPackage === pkg.id && styles.packageCardActive,
                  ]}
                >
                  <Text style={[styles.packageName, selectedPackage === pkg.id && styles.packageNameActive]}>
                    {pkg.name}
                  </Text>
                  <Text style={[styles.packagePrice, selectedPackage === pkg.id && styles.packagePriceActive]}>
                    {naira(pkg.price)}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Pressable
              onPress={() => void continueFromLookup()}
              disabled={!selectedPackage}
              style={({ pressed }) => [
                styles.primaryBtn,
                !selectedPackage && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.primaryText}>Continue</Text>
            </Pressable>
            <Pressable onPress={() => setStep('form')}>
              <Text style={styles.linkText}>Back</Text>
            </Pressable>
          </>
        )}

        {/* ── confirm ─────────────────────────────────────────────────── */}
        {!mainnetOnly && step === 'confirm' && (
          <>
            <View style={styles.card}>
              <Text style={styles.question}>
                {lookupData?.availablePackages.find(p => p.id === selectedPackage)?.name} costs
              </Text>
              <Text style={styles.money}>
                {cost.toFixed(coin === 'xlm' ? 4 : 2)} {code}
              </Text>
            </View>

            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Provider</Text>
                <Text style={styles.rowValue}>{provider}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Smartcard</Text>
                <Text style={styles.rowValue}>{smartcardDigits}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Customer</Text>
                <Text style={styles.rowValue}>{lookupData?.customerName}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Paid from</Text>
                <Text style={styles.rowValue}>{code} balance</Text>
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

            <SlideToConfirm label="Slide to pay" onConfirm={() => void pay()} />
            <Text style={styles.centeredHint}>Then confirm with your passkey</Text>

            <Pressable onPress={() => setStep('lookup')}>
              <Text style={styles.linkText}>Back</Text>
            </Pressable>
          </>
        )}

        {/* ── paying ─────────────────────────────────────────────────── */}
        {!mainnetOnly && step === 'paying' && (
          <>
            <View style={styles.card}>
              <Text style={styles.question}>
                {waitingForPasskey ? 'Confirm with your passkey' : 'Processing your subscription'}
              </Text>
              <Text style={styles.hint}>
                {waitingForPasskey
                  ? 'Face ID, fingerprint or device PIN, whichever this phone uses.'
                  : pollErrorCount > 0
                    ? `Checking status failed — retrying (${pollErrorCount}/${MAX_CONSECUTIVE_POLL_ERRORS})…`
                    : `${provider} is activating your subscription.`}
              </Text>
            </View>

            <View style={styles.waitRow}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.hint}>
                {waitingForPasskey ? 'Waiting for your passkey…' : 'Waiting for confirmation…'}
              </Text>
            </View>
          </>
        )}

        {/* ── done ─────────────────────────────────────────────────── */}
        {!mainnetOnly && step === 'done' && (
          <>
            <View style={styles.card}>
              <Text style={styles.question}>Subscription activated</Text>
              <Text style={styles.hint}>
                Your {provider} subscription is now active. Services usually resume within minutes.
              </Text>
            </View>

            <Pressable
              onPress={() => {
                setStep('form');
                setSmartcard('');
                setSelectedPackage(null);
                setOrderId(null);
                setPayHash(null);
                setSpent(null);
                setLookupData(null);
                void loadRate();
              }}
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
            >
              <Text style={styles.primaryText}>Subscribe again</Text>
            </Pressable>
            <Pressable
              onPress={() => router.back()}
              style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
            >
              <Text style={styles.secondaryText}>Done</Text>
            </Pressable>
          </>
        )}

        {/* ── failed ─────────────────────────────────────────────────── */}
        {!mainnetOnly && step === 'failed' && (
          <>
            <View style={styles.card}>
              <Text style={styles.question}>Payment failed</Text>
              <Text style={styles.hint}>
                Your {(spent ?? cost).toFixed(coin === 'xlm' ? 4 : 2)} {code} is being returned to
                this wallet. No subscription was activated.
              </Text>
            </View>

            <Pressable
              onPress={() => {
                setStep('form');
                setOrderId(null);
                setPayHash(null);
                setError(null);
                setPollErrorCount(0);
                setUnconfirmedReason(null);
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
          </>
        )}

        {/* ── unconfirmed (bounded wait ended or consecutive poll errors) */}
        {!mainnetOnly && step === 'unconfirmed' && (
          <>
            <View style={styles.card}>
              <Text style={styles.question}>
                {unconfirmedReason === 'error'
                  ? "Couldn't confirm status"
                  : 'Delivery taking longer than usual'}
              </Text>
              <Text style={styles.hint}>
                {unconfirmedReason === 'error'
                  ? `Checking status failed after ${MAX_CONSECUTIVE_POLL_ERRORS} attempts. The network service could not be reached, but your subscription may already have been activated.`
                  : `Confirmation from ${provider} is taking longer than usual. Your subscription may already have been activated.`}
              </Text>
            </View>

            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Provider</Text>
                <Text style={styles.rowValue}>{provider}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Smartcard</Text>
                <Text style={styles.rowValue}>{smartcardDigits}</Text>
              </View>
              {lookupData ? (
                <>
                  <View style={styles.row}>
                    <Text style={styles.rowLabel}>Customer</Text>
                    <Text style={styles.rowValue}>{lookupData.customerName}</Text>
                  </View>
                  <View style={styles.row}>
                    <Text style={styles.rowLabel}>Package</Text>
                    <Text style={styles.rowValue}>
                      {lookupData.availablePackages.find(p => p.id === selectedPackage)?.name || 'Unknown'}
                    </Text>
                  </View>
                </>
              ) : null}
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Payment</Text>
                <Text style={styles.rowValue}>
                  {(spent ?? cost).toFixed(coin === 'xlm' ? 4 : 2)} {code} sent
                </Text>
              </View>
              {orderId ? (
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Reference</Text>
                  <Text style={styles.rowValue}>{orderId.slice(0, 8).toUpperCase()}</Text>
                </View>
              ) : null}
            </View>

            <View style={styles.noteCard}>
              <Text style={styles.eyebrow}>WHAT IS KNOWN</Text>
              <Text style={styles.hint}>
                • Your {(spent ?? cost).toFixed(coin === 'xlm' ? 4 : 2)} {code} left this wallet.
              </Text>
              <Text style={styles.hint}>
                • The subscription may already have been activated for smartcard {smartcardDigits}.
              </Text>
              <Text style={styles.hint}>
                • Check your provider's app or website, or wait for a confirmation SMS.
              </Text>
              <Text style={styles.hint}>
                • If the subscription has not arrived, contact support with reference{' '}
                <Text style={styles.linkText}>
                  {orderId ? orderId.slice(0, 8).toUpperCase() : 'above'}
                </Text>.
              </Text>
            </View>

            <Pressable
              disabled={isRechecking}
              onPress={() => {
                if (!pollerRef.current || isRechecking) return;
                setIsRechecking(true);
                pollerRef.current.manualCheck().then((result) => {
                  setIsRechecking(false);
                  if (result === 'done') setStep('done');
                  else if (result === 'failed') setStep('failed');
                  else if (result === 'error') setUnconfirmedReason('error');
                  else setUnconfirmedReason('timeout');
                });
              }}
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
            >
              <Text style={styles.primaryText}>
                {isRechecking ? 'Checking status…' : 'Check status again'}
              </Text>
            </Pressable>
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
    errorCard: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.danger,
      borderRadius: 12,
      padding: 12,
      backgroundColor: colors.dangerSurface,
    },
    errorText: { color: colors.danger, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },

    noteCard: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 16,
      padding: 16,
      backgroundColor: colors.surface,
    },
    eyebrow: { color: colors.textMuted, fontFamily: fontFamily.accent, fontSize: 11, letterSpacing: 0.8 },
    question: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 20 },
    hint: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },
    linkText: { color: colors.accent, fontFamily: fontFamily.body, fontSize: 13, paddingTop: 6, textAlign: 'center' },
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

    field: { gap: 6 },
    label: { color: colors.textMuted, fontFamily: fontFamily.accent, fontSize: 11, letterSpacing: 0.8 },
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

    packageList: { gap: 8 },
    packageCard: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 12,
      padding: 14,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    packageCardActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    packageName: { color: colors.textPrimary, fontFamily: fontFamily.body, fontSize: 15 },
    packagePrice: { color: colors.textMuted, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },
    // A selected card is filled with the accent, so its text has to flip to
    // the on-accent colour or it sits dark-on-gold. Applied at the call site:
    // a `cond && {...}` entry inside StyleSheet.create is a syntax error.
    packageNameActive: { color: colors.onAccent },
    packagePriceActive: { color: colors.onAccent },

    waitRow: { flexDirection: 'row', alignItems: 'center', gap: 10, justifyContent: 'center', paddingVertical: 8 },

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

    disabled: { opacity: 0.4 },
    pressed: { opacity: 0.85 },
  });
}
