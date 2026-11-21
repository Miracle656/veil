/**
 * Fund betting accounts with crypto from this wallet.
 *
 * Follows the same pattern as airtime: reserve, pay from the wallet,
 * poll to a terminal state.
 *
 * Key differences:
 * - Account ID verification via lookup where supported by the provider
 * - Provider-specific (Bet9ja, SportyBet, etc.)
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
  lookupBetting,
  type NairaCoin,
  type BettingLookup,
  classifyBillStatus,
} from '../lib/onramp';
import { BillPoller, MAX_CONSECUTIVE_POLL_ERRORS } from '../lib/billPolling';

type Step = 'form' | 'lookup' | 'confirm' | 'paying' | 'done' | 'failed' | 'unconfirmed';

const PROVIDERS = ['Bet9ja', 'SportyBet', '1xBet', 'BetKing'];

const QUICK_AMOUNTS = [500, 1000, 2000, 5000];

function naira(n: number): string {
  return `₦${n.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}

export default function BettingScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { wallet } = useWallet();

  const { networkName } = useNetwork();
  const mainnetOnly = networkName !== 'mainnet';

  const [step, setStep] = useState<Step>('form');
  const [error, setError] = useState<string | null>(null);

  const [provider, setProvider] = useState<string>('Bet9ja');
  const [accountId, setAccountId] = useState('');
  const [amountNGN, setAmountNGN] = useState('');
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

  const [lookupData, setLookupData] = useState<BettingLookup | null>(null);
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

  const ngn = Number(amountNGN.replace(/[^\d]/g, '')) || 0;
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

  const lookupAccount = useCallback(async () => {
    if (!provider || accountId.length < 3) return;
    setLookupLoading(true);
    setError(null);
    try {
      const data = await lookupBetting({
        provider,
        accountId,
      });
      setLookupData(data);
      setStep('lookup');
    } catch (err) {
      // Lookup not supported or failed - continue without it
      console.warn('[betting] lookup failed:', errorMessage(err));
      setStep('confirm');
    } finally {
      setLookupLoading(false);
    }
  }, [provider, accountId]);

  const continueFromForm = useCallback(async () => {
    if (await isNairaVerified()) {
      await lookupAccount();
      return;
    }
    router.push({
      pathname: '/verify',
      params: {
        returnTo: '/betting',
        label: 'Betting',
        summary: `Betting · ${provider}`,
      },
    });
  }, [router, provider, lookupAccount]);

  const continueFromLookup = useCallback(() => {
    setStep('confirm');
  }, []);

  const pay = useCallback(async () => {
    if (!customerRef || !refundAddress || !rate || ngn <= 0) return;
    setStep('paying');
    setError(null);
    setPollErrorCount(0);
    setUnconfirmedReason(null);
    try {
      const amountStableCoin = Number((ngn / rate).toFixed(7));
      const order = await payBill({
        customerRef,
        billCategory: 'betting',
        provider,
        customerId: accountId,
        amountNgn: ngn,
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
          `This wallet holds ${err.available.toLocaleString('en-US', { maximumFractionDigits: 7 })} ${code}, less than this deposit needs.`,
        );
      } else {
        setError(errorMessage(err));
      }
      setStep('confirm');
    }
  }, [customerRef, refundAddress, rate, ngn, provider, accountId, coin, wallet.deploy, code]);

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
        <FlowHeader title="Betting" />
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
            <Text style={styles.question}>Switch to mainnet to fund betting accounts</Text>
            <Text style={styles.hint}>
              Deposits are vended against real crypto, so this only works on mainnet — there is
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
              <Text style={styles.label}>ACCOUNT ID / PHONE</Text>
              <TextInput
                style={styles.input}
                value={accountId}
                onChangeText={setAccountId}
                keyboardType="default"
                placeholder="Enter account ID or phone number"
                placeholderTextColor={colors.textMuted}
              />
              <Text style={styles.hint}>
                Enter your betting account ID or registered phone number
              </Text>
            </View>

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
              {QUICK_AMOUNTS.map((q) => (
                <Pressable key={q} onPress={() => setAmountNGN(String(q))} style={styles.quickChip}>
                  <Text style={styles.quickText}>₦{q.toLocaleString('en-NG')}</Text>
                </Pressable>
              ))}
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
              disabled={accountId.length < 3 || ngn <= 0 || rateState !== 'ready' || lookupLoading}
              style={({ pressed }) => [
                styles.primaryBtn,
                (accountId.length < 3 || ngn <= 0 || rateState !== 'ready' || lookupLoading) && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.primaryText}>
                {lookupLoading ? 'Verifying...' : 'Continue'}
              </Text>
            </Pressable>
          </>
        )}

        {/* ── lookup results ─────────────────────────────────────────────── */}
        {!mainnetOnly && step === 'lookup' && lookupData && (
          <>
            <View style={styles.card}>
              <Text style={styles.question}>Account verified</Text>
              <Text style={styles.hint}>Account: {lookupData.accountName}</Text>
              <Text style={styles.hint}>Status: {lookupData.accountStatus}</Text>
              {lookupData.balance !== undefined && (
                <Text style={styles.hint}>Current balance: {naira(lookupData.balance)}</Text>
              )}
            </View>

            <Pressable
              onPress={() => void continueFromLookup()}
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
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
                Deposit {naira(ngn)} to {provider} costs
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
                <Text style={styles.rowLabel}>Account</Text>
                <Text style={styles.rowValue}>{accountId}</Text>
              </View>
              {lookupData && (
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Account name</Text>
                  <Text style={styles.rowValue}>{lookupData.accountName}</Text>
                </View>
              )}
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

            <Pressable onPress={() => setStep('form')}>
              <Text style={styles.linkText}>Back</Text>
            </Pressable>
          </>
        )}

        {/* ── paying ─────────────────────────────────────────────────── */}
        {!mainnetOnly && step === 'paying' && (
          <>
            <View style={styles.card}>
              <Text style={styles.question}>
                {waitingForPasskey ? 'Confirm with your passkey' : 'Processing your deposit'}
              </Text>
              <Text style={styles.hint}>
                {waitingForPasskey
                  ? 'Face ID, fingerprint or device PIN, whichever this phone uses.'
                  : pollErrorCount > 0
                    ? `Checking status failed — retrying (${pollErrorCount}/${MAX_CONSECUTIVE_POLL_ERRORS})…`
                    : `${provider} is crediting your account.`}
              </Text>
            </View>

            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Deposit</Text>
                <Text style={styles.rowValue}>
                  {naira(ngn)} · {provider}
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
                {waitingForPasskey ? 'Waiting for your passkey…' : 'Waiting for confirmation…'}
              </Text>
            </View>
          </>
        )}

        {/* ── done ─────────────────────────────────────────────────── */}
        {!mainnetOnly && step === 'done' && (
          <>
            <View style={styles.card}>
              <Text style={styles.question}>Deposit complete</Text>
              <Text style={styles.hint}>
                {naira(ngn)} has been deposited to your {provider} account. It should appear within minutes.
              </Text>
            </View>

            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Provider</Text>
                <Text style={styles.rowValue}>{provider}</Text>
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
                setAccountId('');
                setOrderId(null);
                setPayHash(null);
                setSpent(null);
                setLookupData(null);
                void loadRate();
              }}
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
            >
              <Text style={styles.primaryText}>Deposit again</Text>
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
                this wallet. No deposit was made.
              </Text>
            </View>

            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>{provider} didn't complete the deposit</Text>
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
                  ? `Checking status failed after ${MAX_CONSECUTIVE_POLL_ERRORS} attempts. The network service could not be reached, but your deposit may already have arrived.`
                  : `Confirmation from ${provider} is taking longer than usual. Your deposit may already have arrived.`}
              </Text>
            </View>

            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Provider</Text>
                <Text style={styles.rowValue}>{provider}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Account ID</Text>
                <Text style={styles.rowValue}>{accountId}</Text>
              </View>
              {lookupData ? (
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Account Name</Text>
                  <Text style={styles.rowValue}>{lookupData.accountName}</Text>
                </View>
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
                • The {naira(ngn)} deposit may already have arrived in your {provider} account.
              </Text>
              <Text style={styles.hint}>
                • Check your {provider} app or website to confirm the balance.
              </Text>
              <Text style={styles.hint}>
                • If the deposit has not arrived, contact support with reference{' '}
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
    rowValueStrong: { color: colors.textPrimary, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },

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

    amountRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    currency: { color: colors.textMuted, fontFamily: fontFamily.heading, fontSize: 30 },
    amountInput: { flex: 1, color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 34, paddingVertical: 4 },

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
