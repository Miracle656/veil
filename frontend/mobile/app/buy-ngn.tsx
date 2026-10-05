/**
 * Buy XLM or USDC with naira.
 *
 * Screens a1–a6 of the design, plus the expired case (f1).
 *
 * ## Nothing here signs anything
 *
 * This whole flow is passkey-free. The user is handed a Nigerian account
 * number, transfers naira from their own bank app, and Linq delivers the crypto.
 * The wallet is a destination, not a signer. (Bills are the opposite: their
 * deposit is crypto leaving this wallet, and that payment is signed.)
 *
 * ## Where the money actually lands
 *
 * Linq pays by classic operation, which **cannot name a contract** as a
 * destination — so the delivery address is the fee-payer `G…` account, not the
 * `C…` smart wallet. That is not a compromise: `loadHoldings` already combines
 * the contract's native XLM with the fee-payer account's classic balances, so
 * what arrives there is what the wallet shows. wraith refuses a `C…` before it
 * reaches Linq, and the receive screen made exactly this mistake once.
 *
 * ## The countdown is load-bearing
 *
 * An order holds its rate for a window and then dies, and the account stops
 * accepting the payment. The person this protects is the one who left for their
 * bank app with the number on screen — so the remaining time travels with the
 * account number on every screen that shows it, and the expired screen says
 * plainly not to send.
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
import { useTheme } from '../hooks/useTheme';
import { useNetwork } from '../hooks/useNetwork';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { errorMessage } from '../lib/errorMessage';
import { getFeePayerAddress } from '../lib/activity';
import {
  createOnrampOrder,
  getCustomerRef,
  getOnrampRate,
  isNairaKycMismatch,
  isNairaVerified,
  getOnrampStatus,
  secondsUntil,
  setNairaKycMismatch,
  type NairaCoin,
  type OnrampOrder,
} from '../lib/onramp';

type Step = 'amount' | 'confirm' | 'pay' | 'waiting' | 'done' | 'expired';

/** Verification is once per person, so the outcome is remembered. */

const QUICK_AMOUNTS = [2000, 5000, 10000, 20000];

function naira(n: number): string {
  return `₦${n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function BuyWithNairaScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  // Linq has no sandbox. A G-address is valid on both networks, so a testnet
  // order would take real naira and deliver to an address this build never
  // shows. wraith refuses it; saying so here saves the round trip.
  const { networkName } = useNetwork();
  const mainnetOnly = networkName !== 'mainnet';

  const [step, setStep] = useState<Step>('amount');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [customerRef, setCustomerRef] = useState<string | null>(null);

  const [coin, setCoin] = useState<NairaCoin>('usdc');
  const [amountNGN, setAmountNGN] = useState('');

  // 'loading' and 'failed' are distinct: a missing rate is not the same as a
  // rate we have not asked for yet, and the CTA must not be live for either.
  const [rate, setRate] = useState<number | null>(null);
  const [rateState, setRateState] = useState<'loading' | 'ready' | 'failed'>('loading');

  const [deliveryAddress, setDeliveryAddress] = useState<string | null>(null);
  const [order, setOrder] = useState<OnrampOrder | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [status, setStatus] = useState<string>('initiated');
  const [copied, setCopied] = useState<string | null>(null);

  // Set when Linq says this reference has not completed KYC, after the
  // verification screen believed it had. Terminal on purpose — there is no
  // in-app route out of it, and pretending otherwise is what loops.
  const [kycMismatch, setKycMismatch] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * Hand the one-time check to `/verify`, which both naira flows share.
   *
   * It used to be five stacked inputs on this screen, which meant Airtime
   * either grew its own copy or — as it did — skipped the rule entirely. A NIN
   * also deserves a screen of its own, with room to say what it is for and that
   * we do not keep it; it does not get that sandwiched between a phone number
   * and a Verify button.
   *
   * `replace`, not `push`: there is nothing on this screen worth coming back
   * to before verification, and /verify sends them here itself when it is done.
   */
  const goVerify = useCallback(() => {
    router.replace({
      pathname: '/verify',
      params: { returnTo: '/buy-ngn', label: 'Buy with naira', summary: 'Buying XLM with naira' },
    });
  }, [router]);


  // ── Who we are, to Linq ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // One shared question, the same one Airtime asks. This screen used to
      // read the `veil_ngn_customer` blob directly and look for `verified` on
      // it — but `/verify` records the result under its own key, so a person
      // who had just verified arrived here, failed a check against a blob
      // nothing writes any more, and was sent straight back to the start of
      // verification. That is a loop with no exit.
      //
      // `getCustomerRef` and `isNairaVerified` both still read the legacy blob,
      // so nobody who verified before this change is asked twice — which
      // matters, because Linq allows one verified customer per NIN forever.
      const [ref, verified, mismatch] = await Promise.all([
        getCustomerRef().catch(() => null),
        isNairaVerified().catch(() => false),
        isNairaKycMismatch().catch(() => false),
      ]);
      if (cancelled) return;
      setCustomerRef(ref);
      // A known mismatch outlives the screen it was found on. Sending someone
      // in that state to verify again is the loop described in lib/onramp.ts.
      if (mismatch) {
        setKycMismatch(true);
        return;
      }
      if (!verified) goVerify();
    })();
    return () => {
      cancelled = true;
    };
  }, [goVerify]);

  // ── Where Linq delivers ───────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const addr = await getFeePayerAddress().catch(() => null);
      if (!cancelled) setDeliveryAddress(addr);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Rate ──────────────────────────────────────────────────────────────────
  const loadRate = useCallback(async () => {
    if (mainnetOnly) return;
    setRateState('loading');
    try {
      setRate(await getOnrampRate());
      setRateState('ready');
    } catch {
      setRate(null);
      setRateState('failed');
    }
  }, [mainnetOnly]);

  useEffect(() => {
    void loadRate();
  }, [loadRate]);

  // ── Countdown ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!order) return;
    const tick = () => {
      const left = secondsUntil(order.expiresAt);
      setSecondsLeft(left);
      if (left === 0) setStep((s) => (s === 'pay' || s === 'waiting' ? 'expired' : s));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [order]);

  // ── Status polling, only while an order is live ───────────────────────────
  useEffect(() => {
    if (!order || !customerRef || (step !== 'pay' && step !== 'waiting')) return;
    const check = async () => {
      try {
        const s = await getOnrampStatus(customerRef, order.orderId);
        setStatus(s.status);
        if (/complete|success|settled/i.test(s.status)) setStep('done');
        if (/fail|cancel/i.test(s.status)) setError('This order did not complete.');
      } catch {
        // Silent: a failed poll is not news the user can act on, and the
        // countdown already tells them where they stand.
      }
    };
    void check();
    pollRef.current = setInterval(check, 12_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [order, customerRef, step]);

  const ngn = Number(amountNGN.replace(/[^\d.]/g, '')) || 0;
  const code = coin.toUpperCase();
  const youGet = rate && ngn > 0 ? ngn / rate : 0;

  const copy = useCallback(async (value: string, label: string) => {
    await Clipboard.setStringAsync(value);
    setCopied(label);
    setTimeout(() => setCopied(null), 1600);
  }, []);

  // ── Verification: one time, ever ──────────────────────────────────────────

  // ── Create the order ──────────────────────────────────────────────────────
  const getPaymentDetails = useCallback(async () => {
    if (!customerRef || !deliveryAddress) return;
    setBusy(true);
    setError(null);
    try {
      // Re-read the rate immediately before locking it. The one on screen may
      // be a minute old and XLM floats; this is the number the order carries.
      const fresh = await getOnrampRate();
      setRate(fresh);
      const created = await createOnrampOrder({
        customerRef,
        amountStableCoin: Number((ngn / fresh).toFixed(7)),
        walletAddress: deliveryAddress,
        rate: fresh,
        coin,
      });
      setOrder(created);
      setStatus(created.status);
      setStep('pay');
    } catch (err) {
      const message = errorMessage(err);

      // Linq is the authority on whether this reference is verified, and this
      // is where it answers. The verification screen may have waved the user
      // through on an "already used" NIN, assuming the reference it held was
      // the verified one. When that assumption is wrong, it is wrong here.
      //
      // Do NOT send them back to re-enter the NIN: dedup refuses it, the
      // screen waves them through again, and this fails again — a loop that
      // teaches nothing. Say what is actually true instead, and name the
      // reference, because that is the only thing that identifies the account
      // to support.
      if (/not completed kyc|not verified|kyc/i.test(message)) {
        // Its own flag, not `setNairaVerified(false)`. Clearing the verified
        // flag would send them to /verify on the next visit, where the NIN is
        // refused as already used, which marks them verified, which fails here
        // again. The flag below keeps them on the explanation instead.
        await setNairaKycMismatch(true);
        setKycMismatch(true);
        return;
      }

      setError(message);
    } finally {
      setBusy(false);
    }
  }, [customerRef, deliveryAddress, ngn, coin]);

  const stepNumber = step === 'amount' ? 1 : step === 'confirm' ? 2 : 3;
  const showProgress = step === 'amount' || step === 'confirm' || step === 'pay';

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <FlowHeader title="Buy" />
        {!mainnetOnly && showProgress ? (
          <View style={styles.progressRow}>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { flex: stepNumber }]} />
              <View style={{ flex: 3 - stepNumber }} />
            </View>
            <Text style={styles.progressLabel}>{stepNumber} / 3</Text>
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
            <Text style={styles.question}>Switch to mainnet to buy</Text>
            <Text style={styles.hint}>
              Buying converts real naira into real crypto, so this only works on mainnet —
              there is no test mode. Switch network in Settings, then come back.
            </Text>
          </View>
        ) : null}

        {error ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {kycMismatch ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>
              This wallet&apos;s customer reference has not completed identity
              verification.
            </Text>
            <Text style={styles.hint}>
              Your NIN is verified, but against a different reference — most
              likely one created before this wallet. A NIN can only verify one
              reference, so it cannot be re-used here, and nothing you can do in
              the app will change that.
            </Text>
            <Text style={styles.hint}>Reference: {customerRef}</Text>
            <Text style={styles.hint}>
              Send that reference to support and we will re-bind it.
            </Text>
          </View>
        ) : null}

        {/* ── Verify, once ──────────────────────────────────────────────── */}
        {/* ── a1 · amount ───────────────────────────────────────────────── */}
        {!mainnetOnly && !kycMismatch && step === 'amount' && (
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

            <Text style={styles.question}>You pay</Text>
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

            <View style={styles.card}>
              <Text style={styles.eyebrow}>YOU GET, IN THIS WALLET</Text>
              <Text style={styles.money}>
                {rateState === 'ready' && youGet > 0 ? `${youGet.toFixed(coin === 'xlm' ? 4 : 2)} ${code}` : '—'}
              </Text>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Rate</Text>
                <Text style={styles.rowValue}>
                  {rateState === 'loading'
                    ? 'Checking…'
                    : rateState === 'failed'
                      ? 'Unavailable'
                      : `₦${rate?.toLocaleString('en-NG', { maximumFractionDigits: 2 })} per ${code}`}
                </Text>
              </View>
              {rateState === 'failed' ? (
                <Pressable onPress={() => void loadRate()}>
                  <Text style={styles.linkText}>Try again</Text>
                </Pressable>
              ) : null}
            </View>

            <Text style={styles.hint}>
              You&apos;ll pay by bank transfer from any Nigerian bank app.
            </Text>

            <Pressable
              onPress={() => setStep('confirm')}
              disabled={rateState !== 'ready' || ngn <= 0}
              style={({ pressed }) => [
                styles.primaryBtn,
                (rateState !== 'ready' || ngn <= 0) && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.primaryText}>Continue</Text>
            </Pressable>
          </>
        )}

        {/* ── a2 · confirm ──────────────────────────────────────────────── */}
        {!mainnetOnly && !kycMismatch && step === 'confirm' && (
          <>
            <View style={styles.card}>
              <Text style={styles.eyebrow}>YOU RECEIVE</Text>
              <Text style={styles.money}>
                {youGet.toFixed(coin === 'xlm' ? 4 : 2)} {code}
              </Text>
              <Text style={styles.hint}>into this wallet</Text>
            </View>

            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Rate</Text>
                <Text style={styles.rowValue}>
                  ₦{rate?.toLocaleString('en-NG', { maximumFractionDigits: 2 })} per {code}
                </Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Total to transfer</Text>
                <Text style={styles.rowValueStrong}>{naira(ngn)}</Text>
              </View>
            </View>

            <Text style={styles.hint}>
              Next you&apos;ll get a bank account to send {naira(ngn)} to. The order holds this
              rate until it expires.
            </Text>

            <Pressable
              onPress={getPaymentDetails}
              disabled={busy || !deliveryAddress}
              style={({ pressed }) => [
                styles.primaryBtn,
                (busy || !deliveryAddress) && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              {busy ? (
                <ActivityIndicator color={colors.onAccent} />
              ) : (
                <Text style={styles.primaryText}>Get payment details</Text>
              )}
            </Pressable>
            <Pressable onPress={() => setStep('amount')}>
              <Text style={styles.linkText}>Back</Text>
            </Pressable>
          </>
        )}

        {/* ── a3 · pay this account ─────────────────────────────────────── */}
        {!mainnetOnly && step === 'pay' && order && (
          <>
            <View style={styles.countdownCard}>
              <Text style={styles.eyebrow}>ORDER EXPIRES IN</Text>
              <Text style={styles.countdown}>{secondsLeft === null ? '—' : clock(secondsLeft)}</Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.eyebrow}>TRANSFER EXACTLY</Text>
              <Pressable onPress={() => void copy(String(order.amountNgn), 'amount')}>
                <Text style={styles.money}>{naira(order.amountNgn)}</Text>
                <Text style={styles.linkText}>{copied === 'amount' ? 'Copied' : 'Tap to copy'}</Text>
              </Pressable>
            </View>

            <View style={styles.card}>
              <Text style={styles.eyebrow}>ACCOUNT NUMBER</Text>
              <Pressable onPress={() => void copy(order.accountNumber, 'account')}>
                <Text style={styles.account}>{order.accountNumber}</Text>
                <Text style={styles.linkText}>{copied === 'account' ? 'Copied' : 'Tap to copy'}</Text>
              </Pressable>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Bank</Text>
                <Text style={styles.rowValue}>{order.bankName}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Account name</Text>
                <Text style={styles.rowValue}>{order.accountName}</Text>
              </View>
            </View>

            {/* Said before the bank app says it, so the unfamiliar name on the
                transfer screen reads as expected rather than as a scam. */}
            <View style={styles.noteCard}>
              <Text style={styles.noteTitle}>Your bank will show {order.accountName}</Text>
              <Text style={styles.hint}>
                That&apos;s expected. It is Veil&apos;s payment partner, and it receives this
                transfer for your order.
              </Text>
            </View>

            <Text style={styles.hint}>
              You can leave Veil to make the transfer. This order stays open until it&apos;s paid
              or expires.
            </Text>

            <Pressable
              onPress={() => setStep('waiting')}
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
            >
              <Text style={styles.primaryText}>I&apos;ve sent the transfer</Text>
            </Pressable>
          </>
        )}

        {/* ── a4 · waiting ──────────────────────────────────────────────── */}
        {!mainnetOnly && step === 'waiting' && order && (
          <>
            <View style={styles.card}>
              <Text style={styles.eyebrow}>WAITING FOR YOUR TRANSFER</Text>
              <Text style={styles.question}>
                Buying {youGet.toFixed(coin === 'xlm' ? 4 : 2)} {code}
              </Text>
              <Text style={styles.hint}>
                We pick it up as soon as it reaches the account, usually a minute or two after
                you send.
              </Text>
            </View>

            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Order open for</Text>
                <Text style={styles.rowValue}>{secondsLeft === null ? '—' : clock(secondsLeft)}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Waiting for</Text>
                <Text style={styles.rowValue}>{naira(order.amountNgn)}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>To</Text>
                <Text style={styles.rowValue}>
                  {order.bankName} ··{order.accountNumber.slice(-4)}
                </Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Status</Text>
                <Text style={styles.rowValue}>{status}</Text>
              </View>
            </View>

            <Text style={styles.hint}>
              You can close Veil. Your {code} will appear in your balance when it arrives.
            </Text>

            <Pressable onPress={() => setStep('pay')}>
              <Text style={styles.linkText}>Haven&apos;t paid yet? Show the account again</Text>
            </Pressable>
            <Pressable
              onPress={() => router.back()}
              style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
            >
              <Text style={styles.secondaryText}>Back to home</Text>
            </Pressable>
          </>
        )}

        {/* ── a6 · done ─────────────────────────────────────────────────── */}
        {!mainnetOnly && step === 'done' && order && (
          <>
            <View style={styles.card}>
              <Text style={styles.question}>
                {youGet.toFixed(coin === 'xlm' ? 4 : 2)} {code} is in your wallet
              </Text>
              <Text style={styles.hint}>Your {naira(order.amountNgn)} transfer arrived.</Text>
            </View>

            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>You paid</Text>
                <Text style={styles.rowValue}>{naira(order.amountNgn)}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Rate</Text>
                <Text style={styles.rowValue}>
                  ₦{rate?.toLocaleString('en-NG', { maximumFractionDigits: 2 })} per {code}
                </Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Received</Text>
                <Text style={styles.rowValueStrong}>
                  {youGet.toFixed(coin === 'xlm' ? 4 : 2)} {code}
                </Text>
              </View>
            </View>

            <Pressable
              onPress={() => router.back()}
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
            >
              <Text style={styles.primaryText}>Done</Text>
            </Pressable>
          </>
        )}

        {/* ── f1 · expired ──────────────────────────────────────────────── */}
        {!mainnetOnly && step === 'expired' && order && (
          <>
            <View style={styles.card}>
              <Text style={styles.question}>This order expired</Text>
              <Text style={styles.hint}>
                The window ran out before a transfer arrived. Nothing was charged.
              </Text>
            </View>

            {/* The loudest thing on the screen, because the account number is
                still in their bank app's recents. */}
            <View style={styles.dangerCard}>
              <Text style={styles.dangerTitle}>DON&apos;T SEND MONEY TO THIS ACCOUNT</Text>
              <Text style={styles.accountMuted}>{order.accountNumber}</Text>
              <Text style={styles.hint}>
                {order.bankName} · {order.accountName} · {naira(order.amountNgn)}
              </Text>
            </View>

            <Text style={styles.hint}>
              Already sent it? It isn&apos;t lost — start a new order and we&apos;ll match it or
              send it back.
            </Text>

            <Pressable
              onPress={() => {
                setOrder(null);
                setSecondsLeft(null);
                setError(null);
                setStep('amount');
                void loadRate();
              }}
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
            >
              <Text style={styles.primaryText}>Start a new order</Text>
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
    noteCard: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 16,
      padding: 16,
      gap: 6,
      backgroundColor: colors.surface,
    },
    dangerCard: {
      borderWidth: 1,
      borderColor: colors.danger,
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

    countdownCard: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 16,
      padding: 16,
      alignItems: 'center',
      gap: 4,
    },
    countdown: { color: colors.accent, fontFamily: fontFamily.accent, fontSize: 34 },

    eyebrow: { color: colors.textMuted, fontFamily: fontFamily.accent, fontSize: 11, letterSpacing: 0.8 },
    question: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 20 },
    hint: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },
    money: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 28 },
    account: { color: colors.textPrimary, fontFamily: fontFamily.address, fontSize: 24, letterSpacing: 1 },
    accountMuted: { color: colors.textMuted, fontFamily: fontFamily.address, fontSize: 20, letterSpacing: 1 },

    noteTitle: { color: colors.textPrimary, fontFamily: fontFamily.bodySemiBold, fontSize: 14 },
    dangerTitle: { color: colors.danger, fontFamily: fontFamily.accent, fontSize: 12, letterSpacing: 0.8 },

    row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
    rowLabel: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13 },
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

    amountRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    currency: { color: colors.textMuted, fontFamily: fontFamily.heading, fontSize: 30 },
    amountInput: { flex: 1, color: colors.textPrimary, fontFamily: fontFamily.heading, fontSize: 34, paddingVertical: 4 },

    quickRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
    quickChip: {
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    quickText: { color: colors.textPrimary, fontFamily: fontFamily.body, fontSize: 13 },

    // A pill, matching every other primary action and the artboard's
    // `--pill, 100px`.
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
    linkText: { color: colors.accent, fontFamily: fontFamily.body, fontSize: 13, paddingTop: 6 },

    disabled: { opacity: 0.4 },
    pressed: { opacity: 0.85 },
  });
}
