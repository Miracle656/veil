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
import { useRouter } from 'expo-router';
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
  activeOrderId,
  forgetActiveOrder,
  isTerminal,
  rememberActiveOrder,
  verifyBankAccount,
  type OfframpOrder,
  type VerifiedBank,
} from '../lib/offramp';
import { getFeePayerAddress } from '../lib/activity';
import { getWalletAddress } from '../lib/walletStore';
import { loadHoldings, type Holding } from '../lib/holdings';
import { errorMessage } from '../lib/errorMessage';
import { spendAsset } from '../lib/spendAsset';
import { useWallet } from '../components/WalletProvider';

/** Circle's USDC on mainnet — the only asset Linq's Stellar leg credits. */
const USDC_MAINNET_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

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

/**
 * Linq's status strings in the user's terms.
 *
 * Theirs describe their own internals — "processing: wallet worker on it.."
 * sounds like work is happening TO the order when it means they are waiting
 * for a deposit that only the user can make. Left as-is, the screen tells
 * someone to stand by at the exact moment they need to act.
 */
function describeStatus(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('wallet worker') || s === 'initiated') {
    return 'Waiting for your USDC to arrive';
  }
  if (s.includes('bank queue')) return 'Deposit received — sending to the bank';
  if (s.includes('disbursed')) return 'Naira sent to the bank account';
  if (s.includes('settled')) return 'Complete';
  if (s.includes('timeout')) return 'Expired — no deposit arrived in time';
  if (s.includes('failed')) return 'The bank payout failed';
  return status;
}

export default function CashOutScreen() {
  const router = useRouter();
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
  // Linq expires an order 10 minutes after creation if no deposit arrives.
  // Without a visible clock the screen reads as "working on it" when in fact
  // it is waiting for the user, and the window closes silently.
  const [createdAt, setCreatedAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [status, setStatus] = useState<string>('initiated');
  const [copied, setCopied] = useState(false);
  const [bankQuery, setBankQuery] = useState('');
  const [payHash, setPayHash] = useState<string | null>(null);
  const { wallet } = useWallet();

  /**
   * Pay the deposit without leaving the screen.
   *
   * Handing this to /send meant the order fell out of view at the exact moment
   * it mattered, and the passkey — the thing that makes this wallet what it is
   * — appeared on a different screen with none of the order's context. The
   * routing is shared with the send screen rather than copied, so both spend
   * from the same source for the same balance.
   */
  const payFromWallet = async () => {
    if (!order) return;
    setError(null);
    setBusy(true);
    try {
      const hash = await spendAsset({
        to: order.walletAddress,
        amount: String(order.amountStableCoin),
        asset: { code: 'USDC', issuer: USDC_MAINNET_ISSUER },
        deploy: wallet.deploy,
      });
      setPayHash(hash);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Typed through an in-brand keypad rather than the OS keyboard: this is the
  // only field on the screen, and a system numpad covering the balance and
  // rate while the user decides an amount is a worse trade than owning the
  // keys.
  const pressKey = (k: string) => {
    setAmountNGN((prev) => {
      if (k === '<') return prev.slice(0, -1);
      if (k === '.') return prev.includes('.') ? prev : prev === '' ? '0.' : prev + '.';
      const next = prev === '0' ? k : prev + k;
      return next.replace(/^0+(?=[0-9])/, '');
    });
  };

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

  // Resume an order left in flight.
  //
  // Sending the deposit means leaving this screen, and coming back used to
  // land on a blank amount form with the order gone — after real money had
  // been sent. The id is all that needs remembering; the backend holds the
  // rest, so the status below is authoritative rather than a local guess.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const id = await activeOrderId();
      if (!id || !alive) return;
      try {
        const live = await getOrderStatus(id);
        if (!alive) return;
        setStatus(live.status);
        if (isTerminal(live.status)) {
          setStep('done');
          void forgetActiveOrder();
          return;
        }
        setOrder({
          id: live.id,
          walletAddress: live.depositAddress ?? '',
          coinType: '',
          chain: 'stellar',
          coin: 'usdc',
          amountStableCoin: live.amountStableCoin,
          amountNGN: live.amountNGN,
          rate: 0,
          status: live.status,
        });
        setStep('deposit');
      } catch {
        // Unreachable backend: leave the fresh form rather than showing an
        // order we cannot describe.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

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
      setCreatedAt(Date.now());
      void rememberActiveOrder(created.id);
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
        if (isTerminal(s.status)) {
          setStep('done');
          void forgetActiveOrder();
        }
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

  useEffect(() => {
    if (step !== 'deposit' || createdAt === null) return;
    const tick = () => {
      const left = Math.max(0, 600 - Math.floor((Date.now() - createdAt) / 1000));
      setSecondsLeft(left);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [step, createdAt]);

  const copyDeposit = async () => {
    if (!order) return;
    await Clipboard.setStringAsync(order.walletAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };


  const stepNumber = step === 'amount' ? 1 : step === 'bank' ? 2 : 3;
  const filteredBanks = NIGERIAN_BANKS.filter((b) =>
    b.name.toLowerCase().includes(bankQuery.trim().toLowerCase()),
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <FlowHeader title="Cash out" />
        {/* A three-step line under the title. The flow leaves the screen to
            send, so knowing where you are in it — and that there is an end —
            is worth the two lines it costs. */}
        {!mainnetOnly && step !== 'deposit' && step !== 'done' ? (
          <View style={styles.progressRow}>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { flex: stepNumber }]} />
              <View style={{ flex: 3 - stepNumber }} />
            </View>
            <Text style={styles.progressLabel}>{stepNumber} / 3</Text>
          </View>
        ) : null}
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.body}>
        {mainnetOnly ? (
          <View style={styles.hairlineCard}>
            <Text style={styles.eyebrow}>MAINNET ONLY</Text>
            <Text style={styles.question}>Switch to mainnet to cash out</Text>
            <Text style={styles.hint}>
              Payouts settle in real naira against real USDC, so this only works on
              mainnet — there is no test mode. Switch network in Settings, then come back.
            </Text>
          </View>
        ) : null}

        {!mainnetOnly && step === 'amount' && (
          <>
            <View style={styles.hairlineCard}>
              <Text style={styles.eyebrow}>AVAILABLE TO CASH OUT</Text>
              <Text style={styles.money}>
                {usdcBalance === null ? '—' : `${usdcBalance.toFixed(2)} USDC`}
              </Text>
              {maxNGN !== null ? (
                <Text style={styles.hint}>up to ₦{maxNGN.toLocaleString('en-US')}</Text>
              ) : null}
            </View>

            <Text style={styles.question}>How much do you want to receive?</Text>

            <View style={styles.amountRow}>
              <Text style={styles.currency}>₦</Text>
              <Text style={styles.amountValue} numberOfLines={1}>
                {amountNGN === '' ? '0' : Number(amountNGN).toLocaleString('en-US')}
              </Text>
            </View>

            <View style={styles.underAmount}>
              <Text style={styles.hint}>
                {estimatedUsdc !== null ? `≈ ${estimatedUsdc.toFixed(2)} USDC` : ' '}
              </Text>
              {maxNGN !== null && maxNGN > 0 ? (
                <Pressable
                  onPress={() => setAmountNGN(String(maxNGN))}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.maxPill, pressed && styles.pressed]}
                >
                  <Text style={styles.maxPillText}>Max · ₦{maxNGN.toLocaleString('en-US')}</Text>
                </Pressable>
              ) : null}
            </View>

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
                Rate ₦{rate?.toLocaleString('en-US')} per USDC — indicative. The rate is
                fixed when the order is created.
              </Text>
            )}

            {overBalance ? (
              <Text style={styles.error}>
                That is more than this wallet holds. The most you can cash out is ₦
                {maxNGN?.toLocaleString('en-US')}.
              </Text>
            ) : null}

            <View style={styles.keypad}>
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '<'].map((k) => (
                <Pressable
                  key={k}
                  onPress={() => pressKey(k)}
                  accessibilityRole="button"
                  accessibilityLabel={k === '<' ? 'Delete' : k}
                  style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
                >
                  <Text style={styles.keyText}>{k === '<' ? '⌫' : k}</Text>
                </Pressable>
              ))}
            </View>

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
            <Text style={styles.question}>Which account should we pay?</Text>

            <View style={styles.field}>
              <View style={styles.fieldHead}>
                <Text style={styles.eyebrow}>ACCOUNT NUMBER</Text>
                <Text style={styles.counter}>{accountNumber.trim().length} / 10</Text>
              </View>
              <TextInput
                style={styles.fieldInput}
                value={accountNumber}
                onChangeText={setAccountNumber}
                keyboardType="number-pad"
                maxLength={10}
                placeholder="0000000000"
                placeholderTextColor={colors.textFaint}
                accessibilityLabel="Account number"
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.eyebrow}>BANK</Text>
              {/* A searchable list, not a wrap of chips. Fifteen banks as pills
                  is a wall to scan; typing two letters is faster than reading
                  all of them, and the list scales when more are added. */}
              <TextInput
                style={styles.fieldInput}
                value={bankQuery}
                onChangeText={setBankQuery}
                placeholder="Search banks"
                placeholderTextColor={colors.textFaint}
                accessibilityLabel="Search banks"
              />
              {bankQuery.trim() === '' ? <Text style={styles.eyebrowSub}>POPULAR</Text> : null}
              <View>
                {filteredBanks.map((b, i) => {
                  const active = bankCode === b.code;
                  return (
                    <Pressable
                      key={b.code}
                      onPress={() => setBankCode(b.code)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      style={({ pressed }) => [
                        styles.bankRow,
                        i > 0 && styles.bankRowDivider,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Text style={[styles.bankName, active && styles.bankNameActive]}>
                        {b.name}
                      </Text>
                      {active ? <Text style={styles.tick}>✓</Text> : null}
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {/* The bank's own answer, in teal. This is the one fact on the
                screen the user did not supply, and the only guard against
                paying a stranger — so it is confirmed here, not buried. */}
            {verified ? (
              <View style={styles.verifiedBox}>
                <Text style={styles.verifiedEyebrow}>ACCOUNT VERIFIED</Text>
                <Text style={styles.verifiedName}>{verified.accountName.toUpperCase()}</Text>
              </View>
            ) : null}

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
            <View style={styles.hairlineCard}>
              <Text style={styles.eyebrow}>THEY RECEIVE</Text>
              <Text style={styles.moneyLarge}>₦{ngn.toLocaleString('en-US')}</Text>
              <Text style={styles.hint}>
                You send {estimatedUsdc !== null ? `≈ ${estimatedUsdc.toFixed(2)} USDC` : '—'}
              </Text>
            </View>

            <View style={styles.rows}>
              <Row label="To" value={verified.accountName} />
              <Row label="Bank" value={verified.bankName || bankName(verified.bankCode)} />
              <Row label="Account" value={verified.accountNumber} mono />
              <Row label="Rate" value={`₦${order?.rate?.toLocaleString('en-US') ?? rate?.toLocaleString('en-US')} / USDC`} />
              {/* True, and worth saying: the fee payer covers it, so the amount
                  the user sends is the amount that counts. */}
              <Row label="Network fee" value="Sponsored" accent />
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
            <Text style={styles.eyebrow}>SEND THIS USDC NOW</Text>

            <View style={styles.depositHead}>
              <View>
                <Text style={styles.moneyLarge}>{order.amountStableCoin}</Text>
                <Text style={styles.hint}>USDC</Text>
              </View>
              {/* A ring, not a line of text. The window is the one thing on
                  this screen that runs out, and it should look like it is. */}
              <View style={styles.ring}>
                <Text style={[styles.ringTime, secondsLeft !== null && secondsLeft < 120 && styles.ringUrgent]}>
                  {secondsLeft === null
                    ? '—'
                    : `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`}
                </Text>
                <Text style={styles.ringLabel}>left</Text>
              </View>
            </View>

            <Text style={styles.hint}>The order expires if nothing arrives in time.</Text>

            <View style={styles.field}>
              <Text style={styles.eyebrow}>TO · ON STELLAR</Text>
              <View style={styles.addressChip}>
                <Text style={styles.address} numberOfLines={2}>
                  {order.walletAddress}
                </Text>
                <Pressable onPress={copyDeposit} accessibilityRole="button" hitSlop={8}>
                  <Text style={styles.copy}>{copied ? 'Copied' : 'Copy'}</Text>
                </Pressable>
              </View>
            </View>

            <View style={styles.rows}>
              <Row label="They receive" value={`₦${order.amountNGN.toLocaleString('en-US')}`} />
              <Row label="Rate" value={`₦${order.rate.toLocaleString('en-US')} / USDC`} />
              <Row label="Status" value={describeStatus(status)} accent />
            </View>

            <Text style={styles.hint}>
              Send less and the payout follows what actually arrives, proportionally.
            </Text>

            {/* Paying from the wallet is the path — the passkey is the whole
                point of this app. Sending from elsewhere stays available, but
                as the quiet alternative rather than the only option. */}
            <Pressable
              onPress={payFromWallet}
              disabled={busy || payHash !== null}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.primary,
                (busy || payHash !== null) && styles.primaryDisabled,
                pressed && styles.pressed,
              ]}
            >
              {busy ? (
                <ActivityIndicator color={colors.onAccent} />
              ) : (
                <Text style={styles.primaryText}>
                  {payHash
                    ? 'Sent — waiting for Linq'
                    : `Pay ${order.amountStableCoin} USDC from this wallet`}
                </Text>
              )}
            </Pressable>

            <Pressable onPress={copyDeposit} accessibilityRole="button" style={styles.secondary}>
              <Text style={styles.secondaryText}>I&apos;ll send it from elsewhere</Text>
            </Pressable>
          </>
        )}

        {!mainnetOnly && step === 'done' && (
          <>
            <View style={styles.hairlineCard}>
              <Text style={styles.eyebrow}>{isFailure(status) ? 'NOT COMPLETED' : 'PAID OUT'}</Text>
              <Text style={[styles.moneyLarge, isFailure(status) ? styles.failed : styles.settled]}>
                {isFailure(status) ? '—' : `₦${(order?.amountNGN ?? 0).toLocaleString('en-US')}`}
              </Text>
              <Text style={styles.hint}>{describeStatus(status)}</Text>
            </View>

            {/* A bare figure is not a receipt. This is the last thing the user
                sees of a payment they cannot reverse, so it says who was paid,
                where, and what it cost — the details they would otherwise go
                looking for in a bank app to confirm it was the right account. */}
            <View style={styles.rows}>
              {verified ? (
                <>
                  <Row label="To" value={verified.accountName} />
                  <Row label="Bank" value={verified.bankName || bankName(verified.bankCode)} />
                  <Row label="Account" value={verified.accountNumber} mono />
                </>
              ) : null}
              {order ? (
                <>
                  <Row label="You sent" value={`${order.amountStableCoin} USDC`} />
                  <Row label="Rate" value={`₦${order.rate.toLocaleString('en-US')} / USDC`} />
                </>
              ) : null}
              <Row label="Network fee" value="Sponsored" accent />
            </View>

            {isFailure(status) ? (
              <Text style={styles.hint}>
                Any USDC that arrived is refunded to your classic address.
              </Text>
            ) : null}

            <Pressable
              onPress={() => router.back()}
              accessibilityRole="button"
              style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
            >
              <Text style={styles.primaryText}>Done</Text>
            </Pressable>
          </>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({
  label,
  value,
  mono,
  accent,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text
        style={[styles.rowValue, mono && styles.rowValueMono, accent && styles.rowValueAccent]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    header: { paddingHorizontal: 20, paddingTop: 16, gap: 12 },
    body: { padding: 20, paddingBottom: 60, gap: 18 },

    progressRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    progressTrack: {
      flex: 1,
      height: 2,
      flexDirection: 'row',
      backgroundColor: colors.border,
      borderRadius: 2,
      overflow: 'hidden',
    },
    progressFill: { backgroundColor: colors.accent },
    progressLabel: {
      color: colors.textFaint,
      fontFamily: fontFamily.address,
      fontSize: 12,
    },

    // Hairlines, not grey blocks. A filled card on a light ground reads as a
    // second surface competing with the page; a rule says "these belong
    // together" and costs nothing.
    hairlineCard: {
      borderTopWidth: 1,
      borderBottomWidth: 1,
      borderColor: colors.border,
      paddingVertical: 16,
      gap: 6,
    },

    eyebrow: {
      color: colors.textFaint,
      fontFamily: fontFamily.accent,
      fontSize: 11,
      letterSpacing: 1.4,
      textTransform: 'uppercase',
    },
    eyebrowSub: {
      color: colors.textFaint,
      fontFamily: fontFamily.accent,
      fontSize: 10,
      letterSpacing: 1.2,
      marginTop: 12,
      marginBottom: 2,
    },
    question: { color: colors.textStrong, fontFamily: fontFamily.bodySemiBold, fontSize: 17 },
    hint: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },
    error: { color: colors.danger, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },

    // Lora carries the money — it is the one thing on every screen the user is
    // actually deciding about.
    money: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 26 },
    moneyLarge: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 40 },
    settled: { color: colors.positive },
    failed: { color: colors.danger },

    amountRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
    currency: { color: colors.textFaint, fontFamily: fontFamily.heading, fontSize: 30 },
    amountValue: { flex: 1, color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 44 },
    underAmount: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },

    maxPill: {
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border,
    },
    maxPillText: { color: colors.accentText, fontFamily: fontFamily.bodySemiBold, fontSize: 12 },

    keypad: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 },
    key: {
      width: '33.33%',
      paddingVertical: 16,
      alignItems: 'center',
      justifyContent: 'center',
    },
    keyPressed: { opacity: 0.4 },
    keyText: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 26 },

    field: { gap: 8 },
    fieldHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    counter: { color: colors.textFaint, fontFamily: fontFamily.address, fontSize: 12 },
    fieldInput: {
      color: colors.textPrimary,
      fontFamily: fontFamily.address,
      fontSize: 16,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      paddingVertical: 10,
    },

    bankRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 13,
    },
    bankRowDivider: { borderTopWidth: 1, borderTopColor: colors.border },
    bankName: { color: colors.textPrimary, fontFamily: fontFamily.body, fontSize: 15 },
    bankNameActive: { color: colors.accentText, fontFamily: fontFamily.bodySemiBold },
    tick: { color: colors.accentText, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },

    // Teal, because this is a confirmation from outside the app — the bank's
    // own answer — and it should not look like the gold the user has been
    // tapping.
    verifiedBox: {
      backgroundColor: colors.positiveSurface,
      borderRadius: 14,
      paddingHorizontal: 16,
      paddingVertical: 14,
      gap: 4,
    },
    verifiedEyebrow: {
      color: colors.positive,
      fontFamily: fontFamily.accent,
      fontSize: 10,
      letterSpacing: 1.2,
    },
    verifiedName: { color: colors.positive, fontFamily: fontFamily.bodySemiBold, fontSize: 16 },

    rows: { borderTopWidth: 1, borderColor: colors.border },
    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 13,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    rowLabel: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13 },
    rowValue: { color: colors.textPrimary, fontFamily: fontFamily.bodyMedium, fontSize: 14, flexShrink: 1 },
    rowValueMono: { fontFamily: fontFamily.address },
    rowValueAccent: { color: colors.accentText },

    depositHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
    ring: {
      width: 84,
      height: 84,
      borderRadius: 42,
      borderWidth: 2,
      borderColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    ringTime: { color: colors.textStrong, fontFamily: fontFamily.address, fontSize: 18 },
    ringUrgent: { color: colors.danger },
    ringLabel: { color: colors.textFaint, fontFamily: fontFamily.body, fontSize: 11 },

    addressChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 14,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    address: { flex: 1, color: colors.textPrimary, fontFamily: fontFamily.address, fontSize: 12, lineHeight: 18 },
    copy: { color: colors.accentText, fontFamily: fontFamily.bodySemiBold, fontSize: 13 },

    primary: {
      backgroundColor: colors.accent,
      borderRadius: 999,
      paddingVertical: 16,
      paddingHorizontal: 20,
      alignItems: 'center',
      marginTop: 4,
    },
    primaryDisabled: { opacity: 0.35 },
    primaryText: { color: colors.onAccent, fontFamily: fontFamily.bodySemiBold, fontSize: 16 },

    secondary: { paddingVertical: 12, alignItems: 'center' },
    secondaryText: { color: colors.textMuted, fontFamily: fontFamily.bodyMedium, fontSize: 14 },

    pressed: { opacity: 0.6 },
  });
