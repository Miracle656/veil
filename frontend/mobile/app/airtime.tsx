/**
 * Buy airtime with crypto from this wallet.
 *
 * Screens b1–b5 of the design.
 *
 * ## This is the mirror image of the onramp, and that is the point
 *
 * Buying crypto hands the user a bank account and sends them to their bank app;
 * nothing is signed. Airtime is the reverse — the deposit is crypto *leaving*
 * this wallet — so it is signed, with a passkey, and it never leaves the app.
 * That is why it is the better of the two flows and why it ships first.
 *
 * ## The order of operations is not arbitrary
 *
 * `payBill` reserves the order and locks the rate, and returns the address to
 * pay. Only then is anything spent. Reserving first means a failure to reserve
 * costs nothing, and the amount we send is the amount the order was quoted at.
 *
 * ## Underpayment is not a failed order
 *
 * Linq settles at whatever actually arrives, converted at the locked rate —
 * "this is a manual deposit by design". So sending less than quoted buys *less
 * airtime*, silently. The amount sent is therefore taken from the order rather
 * than re-derived from anything on screen.
 *
 * ## The refund address matters most when everything has already gone wrong
 *
 * If the biller rejects the top-up after the deposit lands, the crypto comes
 * back to `refundAddress`. It must be an address the user controls, and a
 * classic `G…` one — a classic payment cannot name a contract. That is the
 * fee-payer account, whose balances the holdings list already shows as part of
 * this wallet.
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

import { ContactIcon } from '../components/icons';
import { pickContactNumber } from '../lib/pickContact';
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
import { NotEnoughToSend, spendAsset } from '../lib/spendAsset';
import {
  getBillStatus,
  getCustomerRef,
  isNairaVerified,
  getOnrampRate,
  payBill,
  type NairaCoin,
} from '../lib/onramp';

type Step = 'form' | 'confirm' | 'paying' | 'done' | 'failed';

const QUICK_AMOUNTS = [200, 500, 1000, 2000];

/**
 * Nigerian mobile prefixes, so the network is detected rather than asked for.
 *
 * Detection is a *suggestion*: numbers are ported, and a ported number sent to
 * the wrong biller is a failed vend. So the picker stays visible and editable,
 * and the hint says where the guess came from.
 */
const PREFIXES: Record<string, string[]> = {
  MTN: ['0803', '0806', '0703', '0706', '0813', '0816', '0810', '0814', '0903', '0906', '0913', '0916'],
  AIRTEL: ['0802', '0808', '0708', '0812', '0701', '0902', '0901', '0904', '0907', '0912'],
  GLO: ['0805', '0807', '0705', '0815', '0811', '0905', '0915'],
  '9MOBILE': ['0809', '0818', '0817', '0909', '0908'],
};

const NETWORKS = Object.keys(PREFIXES);

function detectNetwork(phone: string): string | null {
  const p = phone.replace(/\D/g, '');
  if (p.length < 4) return null;
  const prefix = p.slice(0, 4);
  for (const [network, list] of Object.entries(PREFIXES)) {
    if (list.includes(prefix)) return network;
  }
  return null;
}

function naira(n: number): string {
  return `₦${n.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}

export default function AirtimeScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { wallet } = useWallet();

  const { networkName } = useNetwork();
  const mainnetOnly = networkName !== 'mainnet';

  const [step, setStep] = useState<Step>('form');
  const [error, setError] = useState<string | null>(null);

  const [provider, setProvider] = useState<string>('MTN');
  const [providerTouched, setProviderTouched] = useState(false);
  const [phone, setPhone] = useState('');
  const [amountNGN, setAmountNGN] = useState('');
  const [coin, setCoin] = useState<NairaCoin>('usdc');

  const [rate, setRate] = useState<number | null>(null);
  const [rateState, setRateState] = useState<'loading' | 'ready' | 'failed'>('loading');

  const [customerRef, setCustomerRef] = useState<string | null>(null);
  const [refundAddress, setRefundAddress] = useState<string | null>(null);

  const [orderId, setOrderId] = useState<string | null>(null);
  const [payHash, setPayHash] = useState<string | null>(null);
  const [spent, setSpent] = useState<number | null>(null);
  const [waitingForPasskey, setWaitingForPasskey] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const detected = detectNetwork(phone);
  // A detected network wins until the user overrides it. Ported numbers are why
  // the override exists at all.
  useEffect(() => {
    if (detected && !providerTouched) setProvider(detected);
  }, [detected, providerTouched]);

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

  // Poll the vend result. Unlike the onramp, nothing on-chain says whether the
  // airtime landed — the deposit leaving this wallet is visible, the top-up is
  // not — so asking is the only way to know.
  useEffect(() => {
    if (!orderId || !customerRef || step !== 'paying' || !payHash) return;
    const check = async () => {
      try {
        const s = await getBillStatus(customerRef, orderId);
        if (/complete|success|delivered/i.test(s.status)) setStep('done');
        if (/fail|refund|revers/i.test(s.status)) setStep('failed');
      } catch {
        // Silent. A failed poll is not something the user can act on, and the
        // payment has already left — saying "error" here would read as if it
        // had not.
      }
    };
    void check();
    pollRef.current = setInterval(check, 10_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [orderId, customerRef, step, payHash]);

  const ngn = Number(amountNGN.replace(/[^\d]/g, '')) || 0;
  const code = coin.toUpperCase();
  const cost = rate && ngn > 0 ? ngn / rate : 0;
  const phoneDigits = phone.replace(/\D/g, '');

  /**
   * The one-time NIN check, which this screen never used to ask for.
   *
   * Linq refuses a bill from an unverified customer, so the old path let
   * someone fill in a phone number and an amount, tap through to confirm, and
   * meet "customer … has not completed KYC" at the moment they expected a
   * payment — which is the worst place to learn a rule exists. The check now
   * happens before the summary, and `/verify` is handed enough to bring them
   * back to exactly this airtime purchase.
   */
  const chooseContact = useCallback(async () => {
    const picked = await pickContactNumber();
    if (picked.ok) {
      setPhone(picked.phone);
      setError(null);
      return;
    }
    // A cancel is a decision, not a failure, and gets no message.
    if (picked.reason !== 'cancelled') setError(picked.message);
  }, []);

  const continueFromForm = useCallback(async () => {
    if (await isNairaVerified()) {
      setStep('confirm');
      return;
    }
    router.push({
      pathname: '/verify',
      params: {
        returnTo: '/airtime',
        label: 'Airtime',
        summary: `Airtime · ₦${ngn.toLocaleString('en-NG')} to ${phone}`,
      },
    });
  }, [router, ngn, phone]);

  const phoneValid = phoneDigits.length === 11 && phoneDigits.startsWith('0');

  const pay = useCallback(async () => {
    if (!customerRef || !refundAddress || !rate) return;
    setStep('paying');
    setError(null);
    try {
      // Reserve first, spend second. A reservation that fails costs nothing;
      // a spend with no order behind it is money sent to an address that was
      // never expecting it.
      const amountStableCoin = Number((ngn / rate).toFixed(7));
      const order = await payBill({
        customerRef,
        billCategory: 'airtime',
        provider,
        customerId: phoneDigits,
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
        // From the order, not from the screen: Linq settles at whatever
        // arrives, so an amount that drifted would quietly buy less airtime.
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
          `This wallet holds ${err.available.toLocaleString('en-US', { maximumFractionDigits: 7 })} ${code}, less than this top-up needs.`,
        );
      } else {
        setError(errorMessage(err));
      }
      setStep('confirm');
    }
  }, [customerRef, refundAddress, rate, ngn, provider, phoneDigits, coin, wallet.deploy, code]);

  const stepNumber = step === 'form' ? 1 : 2;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <FlowHeader title="Airtime" />
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
            <Text style={styles.question}>Switch to mainnet to buy airtime</Text>
            <Text style={styles.hint}>
              Top-ups are vended against real crypto, so this only works on mainnet — there is
              no test mode. Switch network in Settings, then come back.
            </Text>
          </View>
        ) : null}

        {error ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {/* ── b1 · form ─────────────────────────────────────────────────── */}
        {!mainnetOnly && step === 'form' && (
          <>
            <Text style={styles.label}>NETWORK</Text>
            <View style={styles.networkRow}>
              {NETWORKS.map((n) => (
                <Pressable
                  key={n}
                  onPress={() => {
                    setProvider(n);
                    setProviderTouched(true);
                  }}
                  style={[styles.networkChip, provider === n && styles.networkChipActive]}
                >
                  <Text style={[styles.networkText, provider === n && styles.networkTextActive]}>
                    {n}
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
                />
                {/* Nobody remembers the number they are topping up. It is
                    almost always someone else's, which is the whole reason
                    this screen exists. */}
                <Pressable
                  onPress={() => void chooseContact()}
                  accessibilityRole="button"
                  accessibilityLabel="Choose from contacts"
                  hitSlop={8}
                  style={({ pressed }) => [styles.contactBtn, pressed && styles.pressed]}
                >
                  <ContactIcon size={17} color={colors.textSecondary} />
                </Pressable>
              </View>
              {detected ? (
                <Text style={styles.hint}>
                  {detected} number, detected from {phoneDigits.slice(0, 4)}
                  {providerTouched && provider !== detected ? ` — sending to ${provider}` : ''}
                </Text>
              ) : (
                <Text style={styles.hint}>
                  Numbers get ported, so check the network above matches.
                </Text>
              )}
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
              disabled={!phoneValid || ngn <= 0 || rateState !== 'ready'}
              style={({ pressed }) => [
                styles.primaryBtn,
                (!phoneValid || ngn <= 0 || rateState !== 'ready') && styles.disabled,
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
              <Text style={styles.question}>
                {naira(ngn)} airtime to {phoneDigits} costs
              </Text>
              <Text style={styles.money}>
                {cost.toFixed(coin === 'xlm' ? 4 : 2)} {code}
              </Text>
            </View>

            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Network</Text>
                <Text style={styles.rowValue}>{provider}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Phone</Text>
                <Text style={styles.rowValue}>{phoneDigits}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Paid from</Text>
                <Text style={styles.rowValue}>{code} balance</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Network fee</Text>
                <Text style={styles.rowValue}>Sponsored</Text>
              </View>
            </View>

            <View style={styles.noteCard}>
              <Text style={styles.hint}>
                If {provider} can&apos;t complete the top-up, the full amount comes straight back
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

        {/* ── b3 · passkey / in flight ──────────────────────────────────── */}
        {!mainnetOnly && step === 'paying' && (
          <>
            <View style={styles.card}>
              <Text style={styles.question}>
                {waitingForPasskey ? 'Confirm with your passkey' : 'Sending your top-up'}
              </Text>
              <Text style={styles.hint}>
                {waitingForPasskey
                  ? 'Face ID, fingerprint or device PIN, whichever this phone uses.'
                  : `${provider} is vending ${naira(ngn)} to ${phoneDigits}.`}
              </Text>
            </View>

            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Airtime</Text>
                <Text style={styles.rowValue}>
                  {naira(ngn)} · {provider} {phoneDigits}
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
                {waitingForPasskey ? 'Waiting for your passkey…' : 'Waiting for the top-up…'}
              </Text>
            </View>
          </>
        )}

        {/* ── b4 · done ─────────────────────────────────────────────────── */}
        {!mainnetOnly && step === 'done' && (
          <>
            <View style={styles.card}>
              <Text style={styles.question}>Airtime sent</Text>
              <Text style={styles.hint}>
                {naira(ngn)} is on {phoneDigits}. It usually shows on the phone within a minute.
              </Text>
            </View>

            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Network</Text>
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

        {/* ── b5 · failed, refunding ────────────────────────────────────── */}
        {!mainnetOnly && step === 'failed' && (
          <>
            <View style={styles.card}>
              <Text style={styles.question}>Payment failed</Text>
              <Text style={styles.hint}>
                Your {(spent ?? cost).toFixed(coin === 'xlm' ? 4 : 2)} {code} is being returned to
                this wallet. No airtime was added to {phoneDigits}.
              </Text>
            </View>

            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>{provider} didn&apos;t complete the top-up</Text>
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
    // The artboard draws the number on a single underline with the contact
    // button on the right, not inside a boxed field.
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

    // A pill, not a rounded rectangle. Every other primary action in the app
    // is fully rounded, and the artboard's is `--pill, 100px`.
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
