import { Keypair } from '@stellar/stellar-sdk';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Button, Card, Screen } from '../components/ui';
import { BackstopDisclosure } from '../components/BackstopDisclosure';
import { useHiddenAmounts } from '../hooks/useHiddenAmounts';
import { useNetwork } from '../hooks/useNetwork';
import { useTheme } from '../hooks/useTheme';
import {
  BACKSTOP_RISK_NOTICE,
  buildBackstopActionXdr,
  loadBackstopLpBalance,
  loadBackstopOverview,
  parseStroops,
  type BackstopAction,
  type BackstopOverview,
  type BackstopPoolInfo,
  type BackstopPosition,
} from '../lib/blend';
import { errorMessage } from '../lib/errorMessage';
import { assertFeePayerCanCoverBackstop } from '../lib/feePayerCheck';
import { requirePasskey } from '../lib/passkey';
import { isPasskeyCancellation, PasskeyCeremonyError } from '../lib/passkeyOutcome';
import { signAndSubmitSorobanXdr } from '../lib/sorobanTx';
import type { ThemeColors } from '../lib/theme';
import { getSignerSecret, getWalletAddress } from '../lib/walletStore';
import { fontFamily, typography } from '../theme/typography';

/**
 * Blend backstop: deposit, queue a withdrawal, cancel it, withdraw.
 *
 * A backstop share is first-loss capital behind a lending pool. Its value rises
 * with the pool's interest and falls when the backstop is drawn to cover bad
 * debt, so this screen shows what the position is worth NOW, never what was put
 * in, and keeps the BLND emissions on a line of their own: they arrive for a
 * different reason and folding them into the position would make it look safer
 * than it is.
 *
 * Every transaction is paid by the classic G… account and goes through the same
 * passkey check and `signAndSubmitSorobanXdr` that lending uses.
 */

const STROOPS = 1e7;
const TAB_BAR_CLEARANCE = 48;

type Step = 'overview' | 'deposit-form' | 'working' | 'done' | 'error';

const ACTION_LABEL: Record<BackstopAction, { working: string; done: string }> = {
  deposit: { working: 'Depositing…', done: 'Deposited' },
  queue: { working: 'Queuing your withdrawal…', done: 'Withdrawal queued' },
  cancel: { working: 'Cancelling your queued withdrawal…', done: 'Withdrawal cancelled' },
  withdraw: { working: 'Withdrawing…', done: 'Withdrawn' },
};

function units(stroops: string | bigint): number {
  return Number(stroops) / STROOPS;
}

function formatAmount(n: number, digits = 4): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function formatUsd(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function formatWhen(expiresAt: number): string {
  return new Date(expiresAt * 1000).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function describeFailure(error: unknown): string {
  if (error instanceof PasskeyCeremonyError) return error.message;
  return errorMessage(error);
}

export default function BackstopRoute() {
  const router = useRouter();
  const { colors } = useTheme();
  const { mask } = useHiddenAmounts();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { network } = useNetwork();

  const [step, setStep] = useState<Step>('overview');
  const [accountAddress, setAccountAddress] = useState<string | null>(null);
  const [overview, setOverview] = useState<BackstopOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [target, setTarget] = useState<BackstopPoolInfo | null>(null);
  const [lpBalance, setLpBalance] = useState<bigint | null>(null);
  const [amount, setAmount] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);

  const [action, setAction] = useState<BackstopAction>('deposit');
  const [progress, setProgress] = useState('Waiting for passkey…');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const load = useCallback(async (address: string) => {
    setLoading(true);
    try {
      setOverview(await loadBackstopOverview(address));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const walletAddress = await getWalletAddress();
      if (cancelled) return;
      if (!walletAddress) {
        router.replace('/lock');
        return;
      }
      const signerSecret = await getSignerSecret();
      if (cancelled) return;
      if (!signerSecret) {
        setErrorMsg('Signing key not found. Return to the dashboard and unlock the wallet again.');
        setStep('error');
        setLoading(false);
        return;
      }
      const address = Keypair.fromSecret(signerSecret).publicKey();
      setAccountAddress(address);
      await load(address);
    })();
    return () => {
      cancelled = true;
    };
  }, [router, load, network.name]);

  const onRefresh = useCallback(async () => {
    if (!accountAddress) return;
    setRefreshing(true);
    await load(accountAddress).finally(() => setRefreshing(false));
  }, [accountAddress, load]);

  const positionIn = (poolId: string) => overview?.positions.find((p) => p.poolId === poolId);

  function openDeposit(pool: BackstopPoolInfo) {
    setTarget(pool);
    setAmount('');
    setLpBalance(null);
    // Someone already in this backstop has been through the notice once; a first
    // deposit must acknowledge it on this screen.
    setAcknowledged(positionIn(pool.poolId) !== undefined);
    setStep('deposit-form');
    if (accountAddress) {
      void loadBackstopLpBalance(accountAddress, pool.lpToken).then(setLpBalance).catch(() => setLpBalance(null));
    }
  }

  const parsed = parseStroops(amount);
  const overBalance = parsed !== null && lpBalance !== null && parsed > lpBalance;
  const canDeposit = parsed !== null && !overBalance && acknowledged;

  /**
   * One path for all four transactions: passkey, fee-payer cover for the REST of
   * the round trip, build, sign, submit. `amount` is tokens for a deposit and
   * shares for everything else.
   */
  async function run(next: BackstopAction, pool: BackstopPoolInfo, stroops: bigint) {
    if (!accountAddress) return;
    setAction(next);
    setProgress('Waiting for passkey…');
    setStep('working');
    setErrorMsg(null);
    try {
      await requirePasskey();
      const signerSecret = await getSignerSecret();
      if (!signerSecret) throw new Error('Signing key not found. Please unlock the wallet again.');

      setProgress('Checking your fee account…');
      await assertFeePayerCanCoverBackstop(accountAddress, next);

      setProgress(ACTION_LABEL[next].working);
      const xdr = await buildBackstopActionXdr({
        action: next,
        backstopId: pool.backstopId,
        poolId: pool.poolId,
        userAddress: accountAddress,
        amount: stroops,
      });
      const hash = await signAndSubmitSorobanXdr({
        xdr,
        signerSecret,
        rpcUrl: network.rpcUrl,
        networkPassphrase: network.networkPassphrase,
        horizonUrl: network.horizonUrl,
      });

      setTxHash(hash);
      setStep('done');
      setAmount('');
      await load(accountAddress);
    } catch (error: unknown) {
      if (isPasskeyCancellation(error)) {
        setErrorMsg(null);
        setStep(next === 'deposit' ? 'deposit-form' : 'overview');
        return;
      }
      setErrorMsg(describeFailure(error));
      setStep('error');
    }
  }

  const lockedShares = (p: BackstopPosition) => p.queued.reduce((sum, q) => sum + BigInt(q.shares), 0n);

  return (
    <Screen edges={['top']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            step === 'overview' ? (
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
            ) : undefined
          }
        >
          <View style={styles.header}>
            <Text style={[typography.accent, styles.eyebrow]}>Blend backstop</Text>
            <Text style={[typography.heading, styles.title]}>First-loss capital</Text>
            <Text style={styles.lede}>
              Back a lending pool&apos;s safety net and earn BLND emissions plus a share of the pool&apos;s interest.
            </Text>
          </View>

          {/* Always on screen, and always before the first deposit button. */}
          <Card style={styles.riskCard}>
            <Text style={[typography.accent, styles.riskLabel]}>Your money can go down</Text>
            <Text style={styles.riskText}>{BACKSTOP_RISK_NOTICE}</Text>
          </Card>

          {step === 'overview' ? (
            loading && !overview ? (
              <View style={styles.centered}>
                <ActivityIndicator color={colors.accent} />
              </View>
            ) : (
              <>
                {overview && overview.failedPoolIds.length > 0 ? (
                  <Card style={styles.card}>
                    <Text style={styles.warning}>
                      {overview.failedPoolIds.length} pool{overview.failedPoolIds.length === 1 ? '' : 's'} did not
                      answer, so a position there may be missing below. Pull down to try again.
                    </Text>
                  </Card>
                ) : null}

                {overview && overview.positions.length > 0 ? (
                  <View style={styles.section}>
                    <Text style={[typography.accent, styles.sectionLabel]}>Your backstop positions</Text>
                    {overview.positions.map((position) => {
                      const locked = lockedShares(position);
                      const active = BigInt(position.activeShares);
                      const unlocked = BigInt(position.unlockedShares);
                      return (
                        <Card key={position.poolId} style={styles.card}>
                          <Text style={styles.assetCode}>{position.poolName} pool</Text>

                          <Text style={styles.muted}>Worth right now</Text>
                          <Text style={styles.heroValue} testID="backstop-current-value">
                            {mask(formatAmount(units(position.lpTokens)))} LP
                          </Text>
                          <Text style={styles.muted}>About {mask(formatUsd(position.usdValue))}</Text>

                          <Text
                            style={[styles.muted, position.sharePrice < 1 && styles.warning]}
                            testID="backstop-share-price"
                          >
                            1 share = {position.sharePrice.toFixed(4)} backstop tokens
                            {position.sharePrice < 1
                              ? '. Below 1: the backstop has lost value since it started, so this is worth less than the shares were issued for.'
                              : '.'}
                          </Text>

                          <View style={styles.divider} />
                          <View style={styles.rowBetween}>
                            <Text style={styles.muted}>Active</Text>
                            <Text style={styles.value}>{mask(formatAmount(units(active)))} shares</Text>
                          </View>
                          {position.queued.map((q) => (
                            <View key={`${q.expiresAt}-${q.shares}`} style={styles.rowBetween}>
                              <Text style={styles.muted}>Queued until {formatWhen(q.expiresAt)}</Text>
                              <Text style={styles.value}>{mask(formatAmount(units(q.shares)))} shares</Text>
                            </View>
                          ))}
                          {unlocked > 0n ? (
                            <View style={styles.rowBetween}>
                              <Text style={styles.positive}>Ready to withdraw</Text>
                              <Text style={styles.value}>{mask(formatAmount(units(unlocked)))} shares</Text>
                            </View>
                          ) : null}
                          {locked > 0n ? (
                            <Text style={styles.footnote}>
                              Queued shares are still backing the pool, so they can still lose value until you withdraw them.
                            </Text>
                          ) : null}

                          {/* Emissions are their own line: a reward, not part of the position. */}
                          <View style={styles.divider} />
                          <View style={styles.rowBetween} testID="backstop-emissions">
                            <View style={styles.flex}>
                              <Text style={styles.muted}>BLND emissions</Text>
                              <Text style={styles.footnote}>
                                Separate from the value above. Rewards for backstopping, not part of your position.
                              </Text>
                            </View>
                            <Text style={styles.value}>{mask(formatAmount(position.emissionsBlnd))} BLND</Text>
                          </View>

                          <View style={styles.actions}>
                            <Button label="Deposit more" variant="ghost" onPress={() => openDeposit(position)} />
                            {active > 0n ? (
                              <Button
                                label="Queue withdrawal"
                                variant="ghost"
                                onPress={() => void run('queue', position, active)}
                              />
                            ) : null}
                            {locked > 0n ? (
                              <Button
                                label="Cancel queued withdrawal"
                                variant="ghost"
                                onPress={() => void run('cancel', position, locked)}
                              />
                            ) : null}
                            {unlocked > 0n ? (
                              <Button label="Withdraw" onPress={() => void run('withdraw', position, unlocked)} />
                            ) : null}
                          </View>
                        </Card>
                      );
                    })}
                  </View>
                ) : null}

                <View style={styles.section}>
                  <Text style={[typography.accent, styles.sectionLabel]}>Pools</Text>
                  {!overview || overview.pools.length === 0 ? (
                    <Card style={styles.card}>
                      <Text style={[typography.heading, styles.cardTitle]}>No backstops to show</Text>
                      <Text style={styles.muted}>
                        No Blend pool is configured for {network.displayName}, or none answered. Pull down to try
                        again.
                      </Text>
                    </Card>
                  ) : (
                    overview.pools
                      .filter((pool) => !positionIn(pool.poolId))
                      .map((pool) => (
                        <Card key={pool.poolId} style={styles.card}>
                          <View style={styles.rowBetween}>
                            <Text style={[typography.heading, styles.cardTitle]}>{pool.poolName} pool</Text>
                            <Text style={[typography.accent, styles.badge]}>Backstop</Text>
                          </View>
                          <Text style={styles.muted}>
                            1 share = {pool.sharePrice.toFixed(4)} backstop tokens ·{' '}
                            {formatAmount(pool.queuedFraction * 100, 1)}% of it is queued to leave
                          </Text>
                          <Button label="Deposit" onPress={() => openDeposit(pool)} />
                        </Card>
                      ))
                  )}
                </View>
              </>
            )
          ) : null}

          {step === 'deposit-form' && target ? (
            <View style={styles.section}>
              <Card style={styles.card}>
                <Text style={[typography.accent, styles.sectionLabel]}>Deposit into the {target.poolName} backstop</Text>
                <View style={styles.amountRow}>
                  <TextInput
                    style={styles.amountInput}
                    value={amount}
                    onChangeText={setAmount}
                    placeholder="0"
                    placeholderTextColor={colors.textFaint}
                    keyboardType="decimal-pad"
                    accessibilityLabel="Deposit amount"
                    autoFocus
                  />
                  <Text style={styles.amountUnit}>LP</Text>
                </View>
                {lpBalance === null ? (
                  <Text style={styles.muted}>Checking your balance…</Text>
                ) : (
                  <View style={styles.rowBetween}>
                    <Text style={[styles.muted, overBalance && styles.warning]}>
                      {overBalance ? 'More than your spending account holds · ' : 'Available '}
                      {mask(formatAmount(units(lpBalance)))} LP
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Use the full available amount"
                      hitSlop={8}
                      onPress={() => setAmount((Number(lpBalance) / STROOPS).toFixed(7).replace(/\.?0+$/, ''))}
                    >
                      <Text style={styles.link}>Max</Text>
                    </Pressable>
                  </View>
                )}
                <Text style={styles.footnote}>
                  The backstop token is a BLND:USDC LP token held in your spending account. Your shares are worth{' '}
                  {target.sharePrice.toFixed(4)} backstop tokens each today and that moves.
                </Text>
              </Card>

              <BackstopDisclosure
                poolId={target.poolId}
                poolName={target.poolName}
                onAcknowledge={() => setAcknowledged(true)}
              />

              <Button
                label="Deposit"
                disabled={!canDeposit}
                onPress={() => parsed !== null && void run('deposit', target, parsed)}
              />
              <Button label="Cancel" variant="ghost" onPress={() => setStep('overview')} />
            </View>
          ) : null}

          {step === 'working' ? (
            <Card variant="md" style={styles.cardCentered}>
              <ActivityIndicator color={colors.accent} />
              <Text style={[typography.heading, styles.cardTitle]}>{progress}</Text>
              <Text style={styles.muted}>Keep the app open until this finishes.</Text>
            </Card>
          ) : null}

          {step === 'done' ? (
            <Card variant="md" style={styles.cardCentered}>
              <Text style={styles.successMark}>✓</Text>
              <Text style={[typography.heading, styles.cardTitle]}>{ACTION_LABEL[action].done}</Text>
              {action === 'queue' ? (
                <Text style={[styles.muted, styles.center]}>
                  Your shares can be withdrawn once the queue ends. You can cancel any time before that.
                </Text>
              ) : null}
              {txHash ? (
                <Text style={styles.hash} numberOfLines={1} ellipsizeMode="middle">
                  {txHash}
                </Text>
              ) : null}
              <Button
                label="Back to backstop"
                onPress={() => {
                  setStep('overview');
                  setTxHash(null);
                }}
              />
            </Card>
          ) : null}

          {step === 'error' ? (
            <Card variant="md" style={styles.cardCentered}>
              <Text style={styles.errorMark}>!</Text>
              <Text style={[typography.heading, styles.cardTitle]}>That didn&apos;t go through</Text>
              {errorMsg ? <Text style={[styles.muted, styles.center]}>{errorMsg}</Text> : null}
              <Button label="Back" variant="ghost" onPress={() => setStep('overview')} />
            </Card>
          ) : null}

          {step === 'overview' ? <Button label="Close" variant="ghost" onPress={() => router.back()} /> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    flex: { flex: 1 },
    content: { paddingBottom: TAB_BAR_CLEARANCE, gap: 20 },
    header: { paddingTop: 16, gap: 6 },
    eyebrow: { color: colors.accent },
    title: { color: colors.textStrong },
    lede: { fontFamily: fontFamily.body, fontSize: 15, lineHeight: 22, color: colors.textMuted },
    riskCard: { padding: 14, gap: 6 },
    riskLabel: { color: colors.danger, fontSize: 11 },
    riskText: { fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19, color: colors.textPrimary },
    section: { gap: 12 },
    sectionLabel: { color: colors.textMuted, fontSize: 11 },
    card: { padding: 18, gap: 10 },
    cardCentered: { padding: 18, gap: 12, alignItems: 'center' },
    cardTitle: { color: colors.textStrong, fontSize: 20, lineHeight: 26 },
    badge: { color: colors.accent, fontSize: 11 },
    rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
    actions: { gap: 8, paddingTop: 4 },
    assetCode: { fontFamily: fontFamily.bodySemiBold, fontSize: 16, color: colors.textPrimary },
    heroValue: { fontFamily: fontFamily.heading, fontSize: 34, lineHeight: 40, color: colors.accentText },
    value: { fontFamily: fontFamily.bodySemiBold, fontSize: 14, color: colors.textPrimary },
    muted: { fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19, color: colors.textMuted },
    footnote: { fontFamily: fontFamily.body, fontSize: 12, lineHeight: 18, color: colors.textMuted },
    positive: { fontFamily: fontFamily.bodySemiBold, fontSize: 13, color: colors.positive },
    warning: { fontFamily: fontFamily.bodyMedium, color: colors.danger },
    link: { fontFamily: fontFamily.bodySemiBold, fontSize: 13, color: colors.accentText },
    amountRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    amountInput: {
      flex: 1,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 34,
      color: colors.textStrong,
      paddingVertical: 4,
    },
    amountUnit: { fontFamily: fontFamily.accent, fontSize: 16, letterSpacing: 1, color: colors.textMuted },
    ackRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
    ackText: { flex: 1, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19, color: colors.textPrimary },
    checkbox: {
      width: 22,
      height: 22,
      borderRadius: 6,
      borderWidth: 1.5,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    checkboxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
    checkMark: { color: colors.textStrong, fontSize: 14, fontFamily: fontFamily.bodySemiBold },
    centered: { paddingVertical: 24, alignItems: 'center' },
    center: { textAlign: 'center' },
    successMark: { fontFamily: fontFamily.bodySemiBold, color: colors.positive, fontSize: 34 },
    errorMark: { fontFamily: fontFamily.bodySemiBold, color: colors.danger, fontSize: 34 },
    hash: { fontFamily: fontFamily.address, fontSize: 12, color: colors.textMuted, alignSelf: 'stretch', textAlign: 'center' },
  });
