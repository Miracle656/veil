import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';

import { FlowHeader } from '../components/FlowHeader';
import { useTheme } from '../hooks/useTheme';
import { useNetwork } from '../hooks/useNetwork';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { NIGERIAN_BANKS, bankName } from '../lib/nigerianBanks';
import {
  OfframpUnavailable,
  createOrder,
  getOfframpRate,
  getOrderStatus,
  isFailure,
  isTerminal,
  verifyBankAccount,
  type OfframpOrder,
  type VerifiedBank,
} from '../lib/offramp';
import { getFeePayerAddress } from '../lib/activity';
import { getWalletAddress } from '../lib/walletStore';
import { loadHoldings, type Holding } from '../lib/holdings';
import { errorMessage } from '../lib/errorMessage';

/**
 * Cash out — USDC to a Nigerian bank account.
 *
 * Four steps, in the order that fails cheapest first: amount, then the bank
 * account (verified against the bank's own records before anything is
 * created), then a review, then the deposit and its status.
 *
 * The bank check is deliberately before order creation. A wrong account name
 * is a failed payout that surfaces minutes later in a webhook, after the USDC
 * has already left — while a name mismatch caught here is just a typo the user
 * fixes on screen.
 */

type Step = 'amount' | 'bank' | 'review' | 'deposit' | 'done';

const POLL_MS = 6_000;

export default function CashOutScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  // Linq's Stellar leg is mainnet only. Their deposit wallets are mainnet
  // accounts and the asset they credit is Circle's mainnet USDC
  // (GA5ZSEJY...), so a testnet wallet has nothing that can reach them: the
  // refund address does not exist on the chain they check, and testnet USDC
  // cannot be sent to a mainnet account at all. There is no sandbox.
  const { networkName } = useNetwork();
  const mainnetOnly = networkName !== 'mainnet';

  const [step, setStep] = useState<Step>('amount');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 'loading' and 'failed' are separate states. Collapsing both into a null
  // rate meant a failed fetch showed "Fetching the current rate..." forever,
  // with no error and nothing to retry — the screen looked busy rather than
  // broken.
  const [rate, setRate] = useState<number | null>(null);
  const [rateState, setRateState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [amountNGN, setAmountNGN] = useState('');

  // What the wallet can actually cash out. Read through loadHoldings so it is
  // the COMBINED figure: a smart wallet holds USDC in two places — the
  // fee-payer's trustline and the contract's own SAC balance — and showing
  // either one alone understates what is spendable.
  const [usdcBalance, setUsdcBalance] = useState<number | null>(null);

  const [bankCode, setBankCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [verified, setVerified] = useState<VerifiedBank | null>(null);

  const [order, setOrder] = useState<OfframpOrder | null>(null);
  const [status, setStatus] = useState<string>('initiated');
  const [copied, setCopied] = useState(false);

  // The idempotency key is generated ONCE per attempt and reused on retry.
  // A fresh key on a retry is how one order becomes two, and the second one
  // also gets paid for.
  const idempotencyKey = useRef<string>(
    `veil_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
  );

  const loadRate = useCallback(() => {
    setRateState('loading');
    getOfframpRate()
      .then((r) => {
        setRate(r.rate);
        setRateState('ready');
      })
      .catch(() => setRateState('failed'));
  }, []);

  useEffect(() => {
    loadRate();
  }, [loadRate]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const address = await getWalletAddress();
        if (!address) return;
        const holdings = await loadHoldings(address);
        const usdc = holdings.find((h: Holding) => h.code.toUpperCase() === 'USDC');
        if (alive) setUsdcBalance(usdc ? Number(usdc.balance) : 0);
      } catch {
        if (alive) setUsdcBalance(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const ngn = Number(amountNGN.replace(/,/g, ''));
  const estimatedUsdc = rate && ngn > 0 ? ngn / rate : null;
  // The most naira this balance can produce, floored to whole naira so the
  // suggestion never asks for more USDC than the wallet holds.
  const maxNGN = rate && usdcBalance ? Math.floor(usdcBalance * rate) : null;
  const overBalance = maxNGN !== null && ngn > maxNGN;

  const handleVerifyBank = async () => {
    setError(null);
    setBusy(true);
    try {
      const v = await verifyBankAccount(bankCode, accountNumber.trim());
      setVerified(v);
      setStep('review');
    } catch (err) {
      setVerified(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateOrder = async () => {
    setError(null);
    setBusy(true);
    try {
      const wallet = await getWalletAddress();
      // The refund address must be the CLASSIC account. A Veil wallet is a
      // contract, which cannot hold a trustline and which Linq rejects — a
      // refund sent there could never settle.
      const feePayer = await getFeePayerAddress();
      if (!wallet || !feePayer) {
        throw new Error('This device has no wallet to cash out from.');
      }
      if (!verified) throw new Error('Verify the bank account first.');

      const created = await createOrder({
        amountNGN: ngn,
        bankAccount: verified.accountNumber,
        bankCode: verified.bankCode,
        bankName: verified.bankName || bankName(verified.bankCode),
        accountName: verified.accountName,
        refundAddress: feePayer,
        walletAddress: wallet,
        idempotencyKey: idempotencyKey.current,
      });
      setOrder(created);
      setStatus(created.status);
      setStep('deposit');
    } catch (err) {
      setError(
        err instanceof OfframpUnavailable
          ? 'Cash out is unavailable right now. Try again shortly.'
          : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  // Poll while the order is in flight. The webhook is a push the backend might
  // have missed — a sleeping instance, a failed delivery — so the screen asks
  // rather than waits to be told.
  useEffect(() => {
    if (step !== 'deposit' || !order) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await getOrderStatus(order.id);
        if (!alive) return;
        setStatus(s.status);
        if (isTerminal(s.status)) setStep('done');
      } catch {
        // Transient: the next tick tries again rather than showing an error
        // over a screen that is otherwise correct.
      }
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [step, order]);

  const copyDeposit = async () => {
    if (!order) return;
    await Clipboard.setStringAsync(order.walletAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <FlowHeader title="Cash out" />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.body}>
        {mainnetOnly ? (
          <View style={styles.card}>
            <Text style={styles.label}>Switch to mainnet to cash out</Text>
            <Text style={styles.hint}>
              Payouts settle in real naira against real USDC, so this only works on
              mainnet — there is no test mode. Switch network in Settings, then come
              back.
            </Text>
          </View>
        ) : null}

        {!mainnetOnly && step === 'amount' && (
          <>
            {/* The balance leads. This screen spends USDC but is denominated in
                naira, so without it the user is asked for a number with no
                stated ceiling — and finds out it was too large only after
                entering their bank details. */}
            <View style={styles.balanceRow}>
              <Text style={styles.balanceLabel}>Available to cash out</Text>
              <Text style={styles.balanceValue}>
                {usdcBalance === null
                  ? '—'
                  : `${usdcBalance.toFixed(2)} USDC${maxNGN !== null ? `  ·  up to ₦${maxNGN.toLocaleString('en-US')}` : ''}`}
              </Text>
            </View>

            <Text style={styles.label}>How much do you want to receive?</Text>
            <View style={styles.amountRow}>
              <Text style={styles.currency}>₦</Text>
              <TextInput
                style={styles.amountInput}
                value={amountNGN}
                onChangeText={setAmountNGN}
                keyboardType="number-pad"
                placeholder="0"
                placeholderTextColor={colors.textFaint}
                accessibilityLabel="Amount in naira"
              />
            </View>
            {maxNGN !== null && maxNGN > 0 ? (
              <Pressable
                onPress={() => setAmountNGN(String(maxNGN))}
                accessibilityRole="button"
                style={({ pressed }) => [styles.maxPill, pressed && styles.pressed]}
              >
                <Text style={styles.maxPillText}>Max · ₦{maxNGN.toLocaleString('en-US')}</Text>
              </Pressable>
            ) : null}

            {rateState === 'failed' ? (
              <Pressable onPress={loadRate} accessibilityRole="button">
                <Text style={styles.error}>
                  Couldn&apos;t reach the rate service. Tap to try again.
                </Text>
              </Pressable>
            ) : rateState === 'loading' ? (
              <Text style={styles.hint}>Fetching the current rate…</Text>
            ) : (
              <Text style={styles.hint}>
                {estimatedUsdc !== null
                  ? `About ${estimatedUsdc.toFixed(2)} USDC at ₦${rate?.toLocaleString('en-US')} — indicative. The rate is fixed when the order is created.`
                  : `₦${rate?.toLocaleString('en-US')} per USDC — indicative. The rate is fixed when the order is created.`}
              </Text>
            )}

            {overBalance ? (
              <Text style={styles.error}>
                That is more than this wallet holds. The most you can cash out is ₦
                {maxNGN?.toLocaleString('en-US')}.
              </Text>
            ) : null}

            <Pressable
              onPress={() => setStep('bank')}
              disabled={!(ngn > 0) || overBalance}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.primary,
                (!(ngn > 0) || overBalance) && styles.primaryDisabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.primaryText}>Continue</Text>
            </Pressable>
          </>
        )}

        {!mainnetOnly && step === 'bank' && (
          <>
            <Text style={styles.label}>Which account should we pay?</Text>

            <View style={styles.bankGrid}>
              {NIGERIAN_BANKS.map((b) => {
                const active = bankCode === b.code;
                return (
                  <Pressable
                    key={b.code}
                    onPress={() => setBankCode(b.code)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    style={[styles.bankPill, active && styles.bankPillActive]}
                  >
                    <Text style={[styles.bankPillText, active && styles.bankPillTextActive]}>
                      {b.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <TextInput
              style={styles.input}
              value={accountNumber}
              onChangeText={setAccountNumber}
              keyboardType="number-pad"
              maxLength={10}
              placeholder="10-digit account number"
              placeholderTextColor={colors.textFaint}
              accessibilityLabel="Account number"
            />

            <Pressable
              onPress={handleVerifyBank}
              disabled={busy || !bankCode || accountNumber.trim().length !== 10}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.primary,
                (busy || !bankCode || accountNumber.trim().length !== 10) && styles.primaryDisabled,
                pressed && styles.pressed,
              ]}
            >
              {busy ? (
                <ActivityIndicator color={colors.onAccent} />
              ) : (
                <Text style={styles.primaryText}>Verify account</Text>
              )}
            </Pressable>
          </>
        )}

        {!mainnetOnly && step === 'review' && verified && (
          <>
            <Text style={styles.label}>Confirm the payout</Text>
            <View style={styles.card}>
              {/* The name is the bank's answer, not the user's typing — it is
                  the whole point of verifying before an order exists. */}
              <Row label="To" value={verified.accountName} />
              {/* Linq echoes a bankName, but not always — and the review step is
                  where the user checks they picked the right bank, so a blank
                  row there defeats the whole point of confirming. Ours is the
                  fallback: the code is what Linq matches on, the name is only
                  ever shown. */}
              <Row label="Bank" value={verified.bankName || bankName(verified.bankCode)} />
              <Row label="Account" value={verified.accountNumber} />
              <Row label="They receive" value={`₦${ngn.toLocaleString('en-US')}`} />
              <Row
                label="You send"
                value={estimatedUsdc !== null ? `≈ ${estimatedUsdc.toFixed(2)} USDC` : '—'}
              />
            </View>
            <Text style={styles.hint}>
              The exact USDC amount is fixed when the order is created, and you have 10
              minutes to send it.
            </Text>

            <Pressable
              onPress={handleCreateOrder}
              disabled={busy}
              accessibilityRole="button"
              style={({ pressed }) => [styles.primary, busy && styles.primaryDisabled, pressed && styles.pressed]}
            >
              {busy ? (
                <ActivityIndicator color={colors.onAccent} />
              ) : (
                <Text style={styles.primaryText}>Create order</Text>
              )}
            </Pressable>
          </>
        )}

        {!mainnetOnly && step === 'deposit' && order && (
          <>
            <Text style={styles.label}>Send exactly this amount</Text>
            <View style={styles.card}>
              <Text style={styles.bigAmount}>{order.amountStableCoin} USDC</Text>
              <Text style={styles.hint}>on Stellar — to</Text>
              <Pressable onPress={copyDeposit} accessibilityRole="button" style={styles.addressBox}>
                <Text style={styles.address}>{copied ? 'Copied' : order.walletAddress}</Text>
              </Pressable>
              <Row label="They receive" value={`₦${order.amountNGN.toLocaleString('en-US')}`} />
              <Row label="Rate" value={`₦${order.rate.toLocaleString('en-US')} / USDC`} />
            </View>

            <View style={styles.statusRow}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.statusText}>{status}</Text>
            </View>
            <Text style={styles.hint}>
              Sending less than the amount above pays out proportionally less — the payout
              follows what actually arrives.
            </Text>
          </>
        )}

        {!mainnetOnly && step === 'done' && (
          <View style={styles.card}>
            <Text style={[styles.bigAmount, isFailure(status) ? styles.failed : styles.settled]}>
              {isFailure(status) ? 'Not completed' : 'Paid out'}
            </Text>
            <Text style={styles.hint}>{status}</Text>
            {isFailure(status) && (
              <Text style={styles.hint}>
                Any USDC that arrived is refunded to your classic address.
              </Text>
            )}
          </View>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    header: { paddingHorizontal: 20, paddingTop: 16 },
    body: { padding: 20, paddingBottom: 60, gap: 16 },

    label: { color: colors.textStrong, fontFamily: fontFamily.bodySemiBold, fontSize: 17 },
    hint: { color: colors.textFaint, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },
    error: { color: colors.danger, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },

    // The balance sits above the input, styled as a statement rather than a
    // field: it is context for the number being typed, not another thing to
    // fill in.
    balanceRow: {
      backgroundColor: colors.surface,
      borderRadius: 20,
      paddingHorizontal: 18,
      paddingVertical: 14,
      gap: 4,
    },
    balanceLabel: {
      color: colors.label,
      fontFamily: fontFamily.accent,
      fontSize: 11,
      letterSpacing: 1,
      textTransform: 'uppercase',
    },
    balanceValue: { color: colors.textStrong, fontFamily: fontFamily.bodySemiBold, fontSize: 16 },

    maxPill: {
      alignSelf: 'flex-start',
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 999,
      backgroundColor: colors.surfaceMd,
      borderWidth: 1,
      borderColor: colors.border,
    },
    maxPillText: { color: colors.accentText, fontFamily: fontFamily.bodySemiBold, fontSize: 13 },

    amountRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    currency: { color: colors.textFaint, fontFamily: fontFamily.heading, fontSize: 34 },
    amountInput: {
      flex: 1,
      color: colors.textStrong,
      fontFamily: fontFamily.heading,
      fontSize: 34,
      paddingVertical: 4,
    },

    input: {
      color: colors.textPrimary,
      fontFamily: fontFamily.address,
      fontSize: 15,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 14,
      paddingVertical: 14,
      paddingHorizontal: 16,
    },

    bankGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    bankPill: {
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    bankPillActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    bankPillText: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13 },
    bankPillTextActive: { color: colors.onAccent, fontFamily: fontFamily.bodySemiBold },

    // Matched to the Assets card on the dashboard: surface fill, radius 20, no
    // outer border. The fill already separates it from the page, and a card
    // here with a border while the dashboard's has none reads as two different
    // designs rather than one.
    card: {
      backgroundColor: colors.surface,
      borderRadius: 20,
      paddingHorizontal: 18,
      paddingVertical: 16,
      gap: 12,
    },
    row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
    rowLabel: { color: colors.textFaint, fontFamily: fontFamily.body, fontSize: 13 },
    rowValue: { color: colors.textPrimary, fontFamily: fontFamily.bodyMedium, fontSize: 14, flexShrink: 1 },

    bigAmount: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 28 },
    settled: { color: colors.positive },
    failed: { color: colors.danger },

    // Keeps its border: it sits INSIDE the card and is tappable, so it needs an
    // edge of its own. The rule is about the outer container, not every surface.
    addressBox: {
      backgroundColor: colors.surfaceMd,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 12,
    },
    address: { color: colors.accentText, fontFamily: fontFamily.address, fontSize: 12, lineHeight: 18 },

    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    statusText: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13, flexShrink: 1 },

    primary: {
      backgroundColor: colors.accent,
      borderRadius: 999,
      paddingVertical: 16,
      alignItems: 'center',
      marginTop: 4,
    },
    primaryDisabled: { opacity: 0.4 },
    primaryText: { color: colors.onAccent, fontFamily: fontFamily.bodySemiBold, fontSize: 16 },
    pressed: { opacity: 0.7 },
  });
