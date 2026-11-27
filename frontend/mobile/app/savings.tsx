import { errorMessage } from '../lib/errorMessage';
import { Keypair } from '@stellar/stellar-sdk';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useTheme } from '../hooks/useTheme';
import { useHiddenAmounts } from '../hooks/useHiddenAmounts';
import { useNetwork } from '../hooks/useNetwork';
import { useWallet } from '../components/WalletProvider';
import type { ThemeColors } from '../lib/theme';
import { fontFamily, typography } from '../theme/typography';
import {
  buildBlendSupplyXdr,
  buildBlendWithdrawXdr,
  loadBlendPools,
  loadBlendPositionsChecked,
  type BlendPool,
  type EarnAsset,
} from '../lib/blend';
import { fundDeposit, loadEarnBalances, type EarnBalances } from '../lib/earnFunding';
import { requirePasskey } from '../lib/passkey';
import { isPasskeyCancellation, PasskeyCeremonyError } from '../lib/passkeyOutcome';
import {
  earnedStroops,
  formatStroops,
  isPoolFullError,
  parseAmountToStroops,
  pickReserve,
  poolsHolding,
  recordAdded,
  recordTakenOut,
  savingsBalances,
  syncPrincipal,
  type SavingsBalance,
} from '../lib/savings';
import { signAndSubmitSorobanXdr } from '../lib/sorobanTx';
import { getSignerSecret, getWalletAddress } from '../lib/walletStore';

/**
 * Savings — the plain-language door onto the Blend lending Earn already runs.
 *
 * It answers three questions and no others: how much is saved, what it earned,
 * and how to add or take out. One balance per asset; which pool holds the money
 * is behind a disclosure at the bottom. No rate is shown on this screen.
 *
 * Money moves through exactly the calls Earn uses (fundDeposit → blend.ts XDR
 * builders → signAndSubmitSorobanXdr), so there is no second signing route.
 */

const STROOPS = 1e7;
const TAB_BAR_CLEARANCE = 48;
/** How often the balance is re-read, so the earned figure visibly moves. */
const REFRESH_MS = 20_000;
const ASSETS: EarnAsset[] = ['USDC', 'XLM'];

type Step = 'home' | 'add' | 'adding' | 'added' | 'take-out' | 'taking-out' | 'taken-out' | 'error';

function describeFailure(error: unknown): string {
  if (error instanceof PasskeyCeremonyError) return error.message;
  const message = errorMessage(error);
  if (isPoolFullError(message)) {
    return 'Savings is full right now, so it cannot take more money. Try again later.';
  }
  return message;
}

export default function SavingsRoute() {
  const router = useRouter();
  const { colors } = useTheme();
  const { mask } = useHiddenAmounts();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { network } = useNetwork();
  const { wallet } = useWallet();

  const [step, setStep] = useState<Step>('home');
  const [accountAddress, setAccountAddress] = useState<string | null>(null);
  const [pools, setPools] = useState<BlendPool[]>([]);
  const [balances, setBalances] = useState<SavingsBalance[]>([]);
  const [principal, setPrincipal] = useState<Map<EarnAsset, bigint>>(new Map());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showWhere, setShowWhere] = useState(false);
  /** The last read of the pools failed, so what is on screen may be out of date. */
  const [readFailed, setReadFailed] = useState(false);
  /** At least one complete read has landed, so an empty list really means nothing saved. */
  const [hasRead, setHasRead] = useState(false);

  const [asset, setAsset] = useState<EarnAsset>('USDC');
  const [amount, setAmount] = useState('');
  const [wallets, setWallets] = useState<EarnBalances | null>(null);
  const [takeOutAsset, setTakeOutAsset] = useState<EarnAsset | null>(null);

  const [progress, setProgress] = useState('Waiting for passkey…');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const accountRef = useRef<string | null>(null);
  accountRef.current = accountAddress;

  const loadPositions = useCallback(
    async (address: string, withPools: boolean) => {
      const [nextPools, positions] = await Promise.all([
        withPools ? loadBlendPools() : Promise.resolve<BlendPool[] | null>(null),
        loadBlendPositionsChecked(address),
      ]);
      if (nextPools) setPools(nextPools.filter((pool) => pool.reserves.length > 0));
      // A failed read says nothing about what is saved: keep what is on screen
      // and leave the principal record alone.
      if (!positions.complete) {
        setReadFailed(true);
        return;
      }
      setReadFailed(false);
      setHasRead(true);
      const next = savingsBalances(positions.positions);
      setBalances(next);
      setPrincipal(await syncPrincipal(network.name, address, next, ASSETS));
    },
    [network.name]
  );

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
      await loadPositions(address, true);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [router, loadPositions]);

  // Re-read the balance while the home view is showing, so earnings tick up.
  useEffect(() => {
    if (step !== 'home' || !accountAddress) return;
    const timer = setInterval(() => {
      const address = accountRef.current;
      if (address) void loadPositions(address, false);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [step, accountAddress, loadPositions]);

  const onRefresh = useCallback(async () => {
    if (!accountAddress) return;
    setRefreshing(true);
    await loadPositions(accountAddress, true).finally(() => setRefreshing(false));
  }, [accountAddress, loadPositions]);

  const target = pickReserve(pools, asset);
  const stroops = parseAmountToStroops(amount);
  const available = wallets ? wallets.inSpending + wallets.inWallet : null;
  const overBalance = stroops !== null && available !== null && Number(stroops) / STROOPS > available + 1e-7;
  const canAdd = stroops !== null && !overBalance && target !== null;

  function openAdd(code: EarnAsset) {
    setAsset(code);
    setAmount('');
    setWallets(null);
    setErrorMsg(null);
    setStep('add');
  }

  // Which assets can be added to depends on what the pools accept.
  const addableAssets = ASSETS.filter((code) => pickReserve(pools, code) !== null);

  useEffect(() => {
    if (step !== 'add') return;
    let cancelled = false;
    setWallets(null);
    loadEarnBalances(asset)
      .then((b) => {
        if (!cancelled) setWallets(b);
      })
      .catch(() => {
        if (!cancelled) setWallets(null);
      });
    return () => {
      cancelled = true;
    };
  }, [step, asset]);

  async function handleAdd() {
    if (!target || !accountAddress || stroops === null || !canAdd) return;
    const { pool, reserve } = target;
    const before = balances.find((b) => b.code === asset)?.valueStroops ?? 0n;
    setProgress('Waiting for passkey…');
    setStep('adding');
    setErrorMsg(null);
    try {
      await requirePasskey();
      const signerSecret = await getSignerSecret();
      if (!signerSecret) throw new Error('Signing key not found. Please unlock the wallet again.');

      setProgress('Preparing…');
      await fundDeposit({
        code: reserve.code,
        amount: Number(stroops) / STROOPS,
        deploy: wallet.deploy,
        onMoving: () => setProgress(`Moving ${reserve.code} from your wallet…`),
      });

      setProgress('Adding to your savings…');
      const xdr = await buildBlendSupplyXdr({
        poolId: pool.id,
        assetContract: reserve.assetId,
        amountInStroops: stroops,
        supplierAddress: accountAddress,
        sourceAddress: accountAddress,
      });
      await signAndSubmitSorobanXdr({
        xdr,
        signerSecret,
        rpcUrl: network.rpcUrl,
        networkPassphrase: network.networkPassphrase,
        horizonUrl: network.horizonUrl,
      });

      await recordAdded(network.name, accountAddress, asset, before, stroops);
      setStep('added');
      setAmount('');
      await loadPositions(accountAddress, false);
    } catch (error: unknown) {
      if (isPasskeyCancellation(error)) {
        setErrorMsg(null);
        setStep('add');
        return;
      }
      setErrorMsg(describeFailure(error));
      setStep('error');
    }
  }

  async function handleTakeOut() {
    const balance = balances.find((b) => b.code === takeOutAsset);
    if (!balance || !accountAddress) return;
    setProgress('Waiting for passkey…');
    setStep('taking-out');
    setErrorMsg(null);
    try {
      await requirePasskey();
      const signerSecret = await getSignerSecret();
      if (!signerSecret) throw new Error('Signing key not found. Please unlock the wallet again.');

      setProgress('Taking your money out…');
      // One position per pool; today that is one transaction.
      for (const position of balance.positions) {
        const xdr = await buildBlendWithdrawXdr({
          poolId: position.poolId,
          assetContract: position.asset,
          depositedStroops: BigInt(position.deposited),
          supplierAddress: accountAddress,
          sourceAddress: accountAddress,
        });
        await signAndSubmitSorobanXdr({
          xdr,
          signerSecret,
          rpcUrl: network.rpcUrl,
          networkPassphrase: network.networkPassphrase,
          horizonUrl: network.horizonUrl,
        });
      }

      await recordTakenOut(network.name, accountAddress, balance.code);
      setStep('taken-out');
      await loadPositions(accountAddress, false);
    } catch (error: unknown) {
      if (isPasskeyCancellation(error)) {
        setErrorMsg(null);
        setStep('take-out');
        return;
      }
      setErrorMsg(describeFailure(error));
      setStep('error');
      // A multi-pool take-out can stop part-way; show what is actually left.
      void loadPositions(accountAddress, false);
    }
  }

  const takeOutBalance = balances.find((b) => b.code === takeOutAsset) ?? null;
  const isEmpty = !loading && hasRead && balances.length === 0;
  const unreadable = !loading && !hasRead && readFailed;

  return (
    <Screen edges={['top']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            step === 'home' ? (
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
            ) : undefined
          }
        >
          <View style={styles.header}>
            <Pressable accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} hitSlop={8}>
              <Text style={styles.link}>← Back</Text>
            </Pressable>
            <Text style={[typography.accent, styles.eyebrow]}>Savings</Text>
            <Text style={[typography.heading, styles.title]}>Your savings</Text>
          </View>

          {step === 'home' && loading ? (
            <View style={styles.centered}>
              <ActivityIndicator color={colors.accent} />
            </View>
          ) : null}

          {step === 'home' && unreadable ? (
            <Card variant="md" style={styles.card}>
              <Text style={[typography.heading, styles.cardTitle]}>We couldn&apos;t load your savings</Text>
              <Text style={styles.body}>
                Your money has not moved. Check your connection and try again.
              </Text>
              <Button label="Try again" onPress={() => void onRefresh()} />
            </Card>
          ) : null}

          {step === 'home' && !loading && hasRead && readFailed ? (
            <Text style={[styles.muted, styles.warning]}>
              Couldn&apos;t refresh just now. These figures may be out of date.
            </Text>
          ) : null}

          {step === 'home' && isEmpty ? (
            <>
              <Card variant="md" style={styles.card}>
                <Text style={[typography.heading, styles.cardTitle]}>Savings that earn while you wait</Text>
                <Text style={styles.body}>
                  Put some of your USDC or XLM aside and it earns a little more every day. You lend it
                  out, and borrowers pay for using it. It stays yours, and you can take it back out any
                  time. Nothing is locked.
                </Text>
                <Text style={styles.body}>
                  Veil is a self-custody wallet, not a bank. Savings can lose value in rare cases, and in
                  a very busy moment taking money out can take a little longer.
                </Text>
              </Card>
              {addableAssets.length > 0 ? (
                addableAssets.map((code) => (
                  <Button key={code} label={`Start saving ${code}`} onPress={() => openAdd(code)} />
                ))
              ) : (
                <Text style={styles.muted}>Savings is not available on {network.displayName} right now.</Text>
              )}
            </>
          ) : null}

          {step === 'home' && !loading && balances.length > 0 ? (
            <>
              {balances.map((balance) => {
                const earned = earnedStroops(balance.valueStroops, principal.get(balance.code) ?? balance.valueStroops);
                return (
                  <Card key={balance.code} variant="md" style={styles.card}>
                    <Text style={[typography.accent, styles.label]}>{balance.code} saved</Text>
                    <Text style={styles.big} accessibilityLabel={`${balance.code} saved`}>
                      {mask(formatStroops(balance.valueStroops, 2))} {balance.code}
                    </Text>
                    <View style={styles.rowBetween}>
                      <Text style={styles.muted}>{earned < 0n ? 'Down so far' : 'Earned so far'}</Text>
                      <Text
                        style={[styles.earned, earned < 0n && styles.warning]}
                        accessibilityLabel={`${balance.code} ${earned < 0n ? 'down so far' : 'earned so far'}`}
                      >
                        {earned < 0n ? '' : '+'}{mask(formatStroops(earned, 6))} {balance.code}
                      </Text>
                    </View>
                    <View style={styles.actions}>
                      <Button label="Add money" fullWidth={false} style={styles.action} onPress={() => openAdd(balance.code)} />
                      <Button
                        label="Take out"
                        variant="ghost"
                        fullWidth={false}
                        style={styles.action}
                        onPress={() => {
                          setTakeOutAsset(balance.code);
                          setStep('take-out');
                        }}
                      />
                    </View>
                  </Card>
                );
              })}

              {addableAssets.filter((code) => !balances.some((b) => b.code === code)).map((code) => (
                <Button key={code} label={`Start saving ${code}`} variant="ghost" onPress={() => openAdd(code)} />
              ))}
            </>
          ) : null}

          {step === 'home' && !loading && balances.length > 0 ? (
            <Text style={styles.footnote}>Earned counts from when Savings started tracking each balance.</Text>
          ) : null}

          {step === 'add' ? (
            <View style={styles.section}>
              {addableAssets.length > 1 ? (
                <View style={styles.actions}>
                  {addableAssets.map((code) => (
                    <Button
                      key={code}
                      label={code}
                      variant={code === asset ? 'gold' : 'ghost'}
                      fullWidth={false}
                      style={styles.action}
                      onPress={() => {
                        setAsset(code);
                        setAmount('');
                      }}
                    />
                  ))}
                </View>
              ) : null}
              <Card style={styles.card}>
                <Text style={[typography.accent, styles.label]}>Add {asset} to your savings</Text>
                <View style={styles.amountRow}>
                  <TextInput
                    style={styles.amountInput}
                    value={amount}
                    onChangeText={setAmount}
                    placeholder="0"
                    placeholderTextColor={colors.textFaint}
                    keyboardType="decimal-pad"
                    accessibilityLabel="Amount to add"
                    autoFocus
                  />
                  <Text style={styles.unit}>{asset}</Text>
                </View>
                {available === null ? (
                  <Text style={styles.muted}>Checking your balance…</Text>
                ) : (
                  <View style={styles.rowBetween}>
                    <Text style={[styles.muted, overBalance && styles.warning]}>
                      {overBalance ? 'More than your wallet holds · ' : 'You can add up to '}
                      {mask(formatStroops(BigInt(Math.floor(available * STROOPS)), 2))} {asset}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Add everything available"
                      onPress={() => setAmount((Math.floor(available * STROOPS) / STROOPS).toFixed(7).replace(/\.?0+$/, ''))}
                      hitSlop={8}
                    >
                      <Text style={styles.link}>Max</Text>
                    </Pressable>
                  </View>
                )}
              </Card>
              <Button label="Add money" disabled={!canAdd} onPress={handleAdd} />
              <Button label="Cancel" variant="ghost" onPress={() => setStep('home')} />
            </View>
          ) : null}

          {step === 'take-out' && takeOutBalance ? (
            <View style={styles.section}>
              <Card style={styles.card}>
                <Text style={[typography.accent, styles.label]}>Take out {takeOutBalance.code}</Text>
                <Text style={styles.big}>
                  {mask(formatStroops(takeOutBalance.valueStroops, 2))} {takeOutBalance.code}
                </Text>
                <Text style={styles.muted}>
                  Everything you have saved in {takeOutBalance.code}, including what it earned, goes back
                  to your spending account.
                </Text>
              </Card>
              <Button label="Take it all out" onPress={handleTakeOut} />
              <Button label="Cancel" variant="ghost" onPress={() => setStep('home')} />
            </View>
          ) : null}

          {step === 'adding' || step === 'taking-out' ? (
            <Card variant="md" style={styles.cardCentered}>
              <ActivityIndicator color={colors.accent} />
              <Text style={[typography.heading, styles.cardTitle]}>{progress}</Text>
              <Text style={styles.muted}>Keep the app open until this finishes.</Text>
            </Card>
          ) : null}

          {step === 'added' || step === 'taken-out' ? (
            <Card variant="md" style={styles.cardCentered}>
              <Text style={styles.successMark}>✓</Text>
              <Text style={[typography.heading, styles.cardTitle]}>
                {step === 'added' ? 'Added to your savings' : 'Money taken out'}
              </Text>
              <Button label="Back to savings" onPress={() => setStep('home')} />
            </Card>
          ) : null}

          {step === 'error' ? (
            <Card variant="md" style={styles.cardCentered}>
              <Text style={styles.errorMark}>!</Text>
              <Text style={[typography.heading, styles.cardTitle]}>That didn&apos;t go through</Text>
              {errorMsg ? <Text style={[styles.muted, styles.center]}>{errorMsg}</Text> : null}
              <Button label="Back to savings" variant="ghost" onPress={() => setStep('home')} />
            </Card>
          ) : null}

          {step === 'home' && !loading ? (
            <View style={styles.where}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: showWhere }}
                onPress={() => setShowWhere((v) => !v)}
                hitSlop={8}
              >
                <Text style={styles.link}>{showWhere ? 'Hide details' : 'Where is my money held?'}</Text>
              </Pressable>
              {showWhere ? (
                <View style={styles.whereBody}>
                  <Text style={styles.muted}>
                    {balances.length > 0
                      ? balances
                          .map((b) => `${b.code}: ${poolsHolding(b, pools).join(', ')} pool on Blend`)
                          .join('\n')
                      : `Savings lends through ${
                          [...new Set(pools.map((p) => p.name))].join(', ') || 'Blend'
                        } on Blend, a lending protocol on Stellar.`}
                  </Text>
                  <Pressable accessibilityRole="link" onPress={() => router.push('/earn' as never)} hitSlop={8}>
                    <Text style={styles.link}>See the pools in Earn →</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          ) : null}
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
    section: { gap: 12 },
    card: { padding: 18, gap: 12 },
    cardCentered: { padding: 18, gap: 12, alignItems: 'center' },
    cardTitle: { color: colors.textStrong, fontSize: 20, lineHeight: 26 },
    label: { color: colors.textMuted, fontSize: 11 },
    body: { fontFamily: fontFamily.body, fontSize: 15, lineHeight: 22, color: colors.textMuted },
    big: { fontFamily: fontFamily.heading, fontSize: 40, lineHeight: 48, color: colors.textStrong },
    earned: { fontFamily: fontFamily.bodySemiBold, fontSize: 16, color: colors.positive },
    rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
    actions: { flexDirection: 'row', gap: 12 },
    action: { flex: 1, paddingVertical: 11 },
    muted: { fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19, color: colors.textMuted },
    footnote: { fontFamily: fontFamily.body, fontSize: 12, lineHeight: 18, color: colors.textMuted },
    warning: { color: colors.danger },
    link: { fontFamily: fontFamily.bodySemiBold, fontSize: 13, color: colors.accentText },
    amountRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    amountInput: {
      flex: 1,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 34,
      color: colors.textStrong,
      paddingVertical: 4,
    },
    unit: { fontFamily: fontFamily.accent, fontSize: 16, letterSpacing: 1, color: colors.textMuted },
    centered: { paddingVertical: 24, alignItems: 'center' },
    center: { textAlign: 'center' },
    where: { gap: 8, paddingTop: 8 },
    whereBody: { gap: 8 },
    successMark: { fontFamily: fontFamily.bodySemiBold, color: colors.positive, fontSize: 34 },
    errorMark: { fontFamily: fontFamily.bodySemiBold, color: colors.danger, fontSize: 34 },
  });
