import { errorMessage } from '../../lib/errorMessage';
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

import { Button, Card, Screen } from '../../components/ui';
import { useTheme } from '../../hooks/useTheme';
import { useHiddenAmounts } from '../../hooks/useHiddenAmounts';
import type { ThemeColors } from '../../lib/theme';
import { fontFamily, typography } from '../../theme/typography';

import {
  buildBlendSupplyXdr,
  buildBlendWithdrawXdr,
  loadBlendPools,
  loadBlendPositions,
  type BlendPool,
  type BlendPosition,
  type BlendReserve,
} from '../../lib/blend';
import { fundDeposit, loadEarnBalances, type EarnBalances } from '../../lib/earnFunding';
import { useNetwork } from '../../hooks/useNetwork';
import { useWallet } from '../../components/WalletProvider';
import { requirePasskey } from '../../lib/passkey';
import { signAndSubmitSorobanXdr } from '../../lib/sorobanTx';
import { getSignerSecret, getWalletAddress } from '../../lib/walletStore';
import { openExternalUrl } from '../../lib/about';

/**
 * Earn — lend idle USDC or XLM to Blend lending pools and redeem it.
 *
 * Deposits run from the spending account. When the money is in the smart
 * wallet instead, the shortfall is moved across first (lib/earnFunding.ts), so
 * what the user can deposit is what the wallet holds, not what one of its two
 * accounts happens to hold.
 *
 * Built from the shared brand primitives (Screen, Card, Button, the Lora /
 * Anton / Inter / Inconsolata type roles) like the other tabs. It used to sit in
 * the generic ScreenScaffold, a system-font page with a back bar that no other
 * tab has.
 */

const STROOPS = 1e7;

/** Clears the floating tab bar and its raised centre button. */
const TAB_BAR_CLEARANCE = 132;

type EarnStep =
  | 'pools'
  | 'deposit-form'
  | 'depositing'
  | 'deposit-done'
  | 'withdraw-form'
  | 'withdrawing'
  | 'withdraw-done'
  | 'error';

function toUnits(stroops: string): number {
  return Number(stroops) / STROOPS;
}

function formatApy(apy: number): string {
  return `${(apy * 100).toFixed(2)}%`;
}

function formatAmount(n: number, digits = 4): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

/** Map a raw failure onto something the user can act on. */
function describeFailure(error: unknown): string {
  const message = errorMessage(error);
  const lower = message.toLowerCase();
  if (lower.includes('cancel') || lower.includes('abort')) {
    return 'Passkey cancelled. Please try again.';
  }
  if (lower.includes('utilization') || lower.includes('cap')) {
    return 'This pool is full right now, so it cannot take deposits. Try again later.';
  }
  return message;
}

type Selected = { pool: BlendPool; reserve: BlendReserve };

export default function EarnRoute() {
  const router = useRouter();
  const { colors } = useTheme();
  const { mask } = useHiddenAmounts();
  const styles = useMemo(() => createStyles(colors), [colors]);
  // Subscribed rather than read once at module load: the network is a runtime
  // choice, and everything on this screen belongs to exactly one chain.
  const { network } = useNetwork();
  const { wallet } = useWallet();

  const [step, setStep] = useState<EarnStep>('pools');
  const [accountAddress, setAccountAddress] = useState<string | null>(null);

  const [pools, setPools] = useState<BlendPool[]>([]);
  const [positions, setPositions] = useState<BlendPosition[]>([]);
  const [loadingPools, setLoadingPools] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [selected, setSelected] = useState<Selected | null>(null);
  const [balances, setBalances] = useState<EarnBalances | null>(null);
  const [depositAmount, setDepositAmount] = useState('');
  const [selectedPosition, setSelectedPosition] = useState<BlendPosition | null>(null);

  const [progress, setProgress] = useState('Waiting for passkey…');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const loadData = useCallback(async (address: string) => {
    setLoadingPools(true);
    const [nextPools, nextPositions] = await Promise.all([
      loadBlendPools(),
      loadBlendPositions(address),
    ]);
    setPools(nextPools.filter((pool) => pool.reserves.length > 0));
    setPositions(nextPositions);
    setLoadingPools(false);
  }, []);

  // ── Load session ──
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const walletAddress = await getWalletAddress();
      if (cancelled) return;
      if (!walletAddress) {
        router.replace('/lock');
        return;
      }

      // Blend is called by the spending account, so that key is what has to be
      // present — not just the wallet contract address.
      const signerSecret = await getSignerSecret();
      if (cancelled) return;
      if (!signerSecret) {
        setErrorMsg('Signing key not found. Return to the dashboard and unlock the wallet again.');
        setStep('error');
        setLoadingPools(false);
        return;
      }

      const resolvedAddress = Keypair.fromSecret(signerSecret).publicKey();
      setAccountAddress(resolvedAddress);
      await loadData(resolvedAddress);
    })();

    return () => {
      cancelled = true;
    };
  }, [router, loadData, network.name]);

  const onRefresh = useCallback(async () => {
    if (!accountAddress) return;
    setRefreshing(true);
    await loadData(accountAddress).finally(() => setRefreshing(false));
  }, [accountAddress, loadData]);

  function openDeposit(pool: BlendPool, reserve: BlendReserve) {
    setSelected({ pool, reserve });
    setBalances(null);
    setDepositAmount('');
    setStep('deposit-form');
    void loadEarnBalances(reserve.code).then(setBalances).catch(() => setBalances(null));
  }

  const available = balances ? balances.inSpending + balances.inWallet : null;
  const parsedAmount = parseFloat(depositAmount);
  const overBalance = parsedAmount > 0 && available !== null && parsedAmount > available + 1e-7;
  const depositIsValid = parsedAmount > 0 && !overBalance;

  // ── Deposit ──
  async function handleDeposit() {
    if (!selected || !accountAddress || !depositIsValid) return;
    const { pool, reserve } = selected;
    setProgress('Waiting for passkey…');
    setStep('depositing');
    setErrorMsg(null);
    try {
      await requirePasskey();

      const signerSecret = await getSignerSecret();
      if (!signerSecret) throw new Error('Signing key not found. Please unlock the wallet again.');

      setProgress('Preparing your deposit…');
      await fundDeposit({
        code: reserve.code,
        amount: parsedAmount,
        deploy: wallet.deploy,
        onMoving: () => setProgress(`Moving ${reserve.code} from your wallet…`),
      });

      setProgress('Depositing…');
      const xdr = await buildBlendSupplyXdr({
        poolId: pool.id,
        assetContract: reserve.assetId,
        amountInStroops: BigInt(Math.round(parsedAmount * STROOPS)),
        supplierAddress: accountAddress,
        sourceAddress: accountAddress,
      });

      const hash = await signAndSubmitSorobanXdr({
        xdr,
        signerSecret,
        rpcUrl: network.rpcUrl,
        networkPassphrase: network.networkPassphrase,
        horizonUrl: network.horizonUrl,
      });

      setTxHash(hash);
      setStep('deposit-done');
      setDepositAmount('');
      await loadData(accountAddress);
    } catch (error: unknown) {
      setErrorMsg(describeFailure(error));
      setStep('error');
    }
  }

  // ── Withdraw ──
  async function handleWithdraw() {
    if (!selectedPosition || !accountAddress) return;
    setProgress('Waiting for passkey…');
    setStep('withdrawing');
    setErrorMsg(null);
    try {
      await requirePasskey();

      const signerSecret = await getSignerSecret();
      if (!signerSecret) throw new Error('Signing key not found. Please unlock the wallet again.');

      setProgress('Withdrawing…');
      const xdr = await buildBlendWithdrawXdr({
        poolId: selectedPosition.poolId,
        assetContract: selectedPosition.asset,
        depositedStroops: BigInt(selectedPosition.deposited),
        supplierAddress: accountAddress,
        sourceAddress: accountAddress,
      });

      const hash = await signAndSubmitSorobanXdr({
        xdr,
        signerSecret,
        rpcUrl: network.rpcUrl,
        networkPassphrase: network.networkPassphrase,
        horizonUrl: network.horizonUrl,
      });

      setTxHash(hash);
      setStep('withdraw-done');
      await loadData(accountAddress);
    } catch (error: unknown) {
      setErrorMsg(describeFailure(error));
      setStep('error');
    }
  }

  const poolName = (poolId: string) =>
    pools.find((p) => p.id === poolId)?.name ?? `${poolId.slice(0, 6)}…`;
  const bestApy = pools.flatMap((p) => p.reserves).reduce((m, r) => Math.max(m, r.supplyApy), 0);

  return (
    <Screen edges={['top']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            step === 'pools' ? (
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
            ) : undefined
          }
        >
          <View style={styles.header}>
            <Text style={[typography.accent, styles.eyebrow]}>Earn</Text>
            <Text style={[typography.heading, styles.title]}>Put idle money to work</Text>
            <Text style={styles.lede}>
              Lend USDC or XLM to Blend and earn interest. Nothing is locked, withdraw any time.
            </Text>
          </View>

          {step === 'pools' ? (
            <>
              <Card style={styles.disclosureCard}>
                <View style={styles.rowBetween}>
                  <Text style={[typography.accent, styles.disclosureLabel]}>Disclosures</Text>
                  <Pressable
                    accessibilityRole="link"
                    accessibilityLabel="Learn how Veil invest works and disclosures"
                    hitSlop={8}
                    onPress={() => void openExternalUrl('https://docs.useveilapp.xyz/invest')}
                  >
                    <Text style={styles.disclosureLink}>How it works &amp; risks →</Text>
                  </Pressable>
                </View>
                <Text style={styles.disclosureText}>
                  Veil is a self-custody wallet, not a broker. Veil never takes custody, never performs KYC, and never gives advice.
                </Text>
              </Card>

              {!loadingPools && bestApy > 0 ? (
                <Card variant="md" style={styles.hero}>
                  <Text style={[typography.accent, styles.heroLabel]}>Best rate today</Text>
                  <Text style={styles.heroRate}>{formatApy(bestApy)}</Text>
                  <Text style={styles.muted}>a year, paid by borrowers. The rate moves with demand.</Text>
                </Card>
              ) : null}

              {positions.length > 0 ? (
                <View style={styles.section}>
                  <Text style={[typography.accent, styles.sectionLabel]}>Your deposits</Text>
                  {positions.map((position) => (
                    <Card key={`${position.poolId}-${position.asset}`} style={styles.card}>
                      <View style={styles.rowBetween}>
                        <View>
                          <Text style={styles.assetCode}>{position.code ?? `${position.asset.slice(0, 6)}…`}</Text>
                          <Text style={styles.muted}>{poolName(position.poolId)} pool</Text>
                        </View>
                        <Text style={styles.value}>
                          {mask(formatAmount(toUnits(position.deposited)))} {position.code ?? ''}
                        </Text>
                      </View>
                      <Button
                        label="Withdraw"
                        variant="ghost"
                        onPress={() => {
                          setSelectedPosition(position);
                          setStep('withdraw-form');
                        }}
                      />
                    </Card>
                  ))}
                </View>
              ) : null}

              <View style={styles.section}>
                <Text style={[typography.accent, styles.sectionLabel]}>Pools</Text>

                {loadingPools ? (
                  <View style={styles.centered}>
                    <ActivityIndicator color={colors.accent} />
                  </View>
                ) : pools.length === 0 ? (
                  <Card style={styles.card}>
                    <Text style={[typography.heading, styles.cardTitle]}>Couldn&apos;t load the pools</Text>
                    <Text style={styles.muted}>
                      The lending pools on {network.displayName} did not answer. Pull down to try again.
                    </Text>
                  </Card>
                ) : (
                  pools.map((pool) => (
                    <Card key={pool.id} style={styles.card}>
                      <View style={styles.rowBetween}>
                        <Text style={[typography.heading, styles.cardTitle]}>{pool.name} pool</Text>
                        <Text style={[typography.accent, styles.badge]}>Blend</Text>
                      </View>
                      {pool.reserves.map((reserve) => (
                        <View key={reserve.assetId} style={styles.reserveRow}>
                          <View style={styles.reserveText}>
                            <Text style={styles.assetCode}>{reserve.code}</Text>
                            <Text style={styles.apy}>{formatApy(reserve.supplyApy)} APY</Text>
                          </View>
                          <Button
                            label="Deposit"
                            fullWidth={false}
                            style={styles.smallButton}
                            onPress={() => openDeposit(pool, reserve)}
                          />
                        </View>
                      ))}
                    </Card>
                  ))
                )}
              </View>
            </>
          ) : null}

          {step === 'deposit-form' && selected ? (
            <View style={styles.section}>
              <Card style={styles.card}>
                <Text style={[typography.accent, styles.sectionLabel]}>
                  Deposit {selected.reserve.code} · {formatApy(selected.reserve.supplyApy)} APY
                </Text>
                <View style={styles.amountRow}>
                  <TextInput
                    style={styles.amountInput}
                    value={depositAmount}
                    onChangeText={setDepositAmount}
                    placeholder="0"
                    placeholderTextColor={colors.textFaint}
                    keyboardType="decimal-pad"
                    accessibilityLabel="Deposit amount"
                    autoFocus
                  />
                  <Text style={styles.amountUnit}>{selected.reserve.code}</Text>
                </View>
                {available === null ? (
                  <Text style={styles.muted}>Checking your balance…</Text>
                ) : (
                  <View style={styles.rowBetween}>
                    <Text style={[styles.muted, overBalance && styles.warning]}>
                      {overBalance ? 'More than your wallet holds · ' : 'Available '}
                      {mask(formatAmount(available))} {selected.reserve.code}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Use the full available amount"
                      onPress={() =>
                        setDepositAmount((Math.floor(available * STROOPS) / STROOPS).toString())
                      }
                      hitSlop={8}
                    >
                      <Text style={styles.link}>Max</Text>
                    </Pressable>
                  </View>
                )}
                {parsedAmount > 0 && !overBalance ? (
                  <Text style={styles.muted}>
                    About{' '}
                    <Text style={styles.positive}>
                      {formatAmount(parsedAmount * selected.reserve.supplyApy)} {selected.reserve.code}
                    </Text>{' '}
                    a year at today&apos;s rate.
                  </Text>
                ) : null}
              </Card>
              <Text style={styles.footnote}>
                In the {selected.pool.name} pool on Blend. Withdrawals return to your spending account.
              </Text>
              <Button label="Deposit" disabled={!depositIsValid} onPress={handleDeposit} />
              <Button label="Cancel" variant="ghost" onPress={() => setStep('pools')} />
            </View>
          ) : null}

          {step === 'withdraw-form' && selectedPosition ? (
            <View style={styles.section}>
              <Card style={styles.card}>
                <Text style={[typography.accent, styles.sectionLabel]}>
                  Withdraw from {poolName(selectedPosition.poolId)}
                </Text>
                <Text style={styles.heroRate}>
                  {mask(formatAmount(toUnits(selectedPosition.deposited)))} {selectedPosition.code ?? ''}
                </Text>
                <Text style={styles.muted}>
                  Everything in this deposit, including interest, returns to your spending account.
                </Text>
              </Card>
              <Button label="Withdraw all" onPress={handleWithdraw} />
              <Button label="Cancel" variant="ghost" onPress={() => setStep('pools')} />
            </View>
          ) : null}

          {step === 'depositing' || step === 'withdrawing' ? (
            <Card variant="md" style={styles.cardCentered}>
              <ActivityIndicator color={colors.accent} />
              <Text style={[typography.heading, styles.cardTitle]}>{progress}</Text>
              <Text style={styles.muted}>Keep the app open until this finishes.</Text>
            </Card>
          ) : null}

          {step === 'deposit-done' || step === 'withdraw-done' ? (
            <Card variant="md" style={styles.cardCentered}>
              <Text style={styles.successMark}>✓</Text>
              <Text style={[typography.heading, styles.cardTitle]}>
                {step === 'deposit-done' ? "You're earning" : 'Withdrawn'}
              </Text>
              {txHash ? (
                <Text style={styles.hash} numberOfLines={1} ellipsizeMode="middle">
                  {txHash}
                </Text>
              ) : null}
              <Button
                label="Back to Earn"
                onPress={() => {
                  setStep('pools');
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
              <Button label="Try again" variant="ghost" onPress={() => setStep('pools')} />
            </Card>
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
    lede: { fontFamily: fontFamily.body, fontSize: 15, lineHeight: 22, color: colors.textMuted },
    hero: { gap: 4 },
    heroLabel: { color: colors.textMuted, fontSize: 11 },
    heroRate: { fontFamily: fontFamily.heading, fontSize: 40, lineHeight: 48, color: colors.accentText },
    section: { gap: 12 },
    sectionLabel: { color: colors.textMuted, fontSize: 11 },
    disclosureCard: { padding: 14, gap: 6 },
    disclosureLabel: { color: colors.accent, fontSize: 11 },
    disclosureLink: { fontFamily: fontFamily.bodySemiBold, fontSize: 12, color: colors.accentText },
    disclosureText: { fontFamily: fontFamily.body, fontSize: 12, lineHeight: 17, color: colors.textMuted },
    card: { padding: 18, gap: 12 },
    cardCentered: { padding: 18, gap: 12, alignItems: 'center' },
    cardTitle: { color: colors.textStrong, fontSize: 20, lineHeight: 26 },
    badge: { color: colors.accent, fontSize: 11 },
    rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
    reserveRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    reserveText: { gap: 2 },
    assetCode: { fontFamily: fontFamily.bodySemiBold, fontSize: 16, color: colors.textPrimary },
    apy: { fontFamily: fontFamily.bodyMedium, fontSize: 13, color: colors.positive },
    value: { fontFamily: fontFamily.bodySemiBold, fontSize: 16, color: colors.textPrimary },
    smallButton: { paddingVertical: 9, paddingHorizontal: 20 },
    muted: { fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19, color: colors.textMuted },
    footnote: { fontFamily: fontFamily.body, fontSize: 12, lineHeight: 18, color: colors.textMuted },
    positive: { fontFamily: fontFamily.bodySemiBold, color: colors.positive },
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
    amountUnit: { fontFamily: fontFamily.accent, fontSize: 16, letterSpacing: 1, color: colors.textMuted },
    centered: { paddingVertical: 24, alignItems: 'center' },
    center: { textAlign: 'center' },
    successMark: { fontFamily: fontFamily.bodySemiBold, color: colors.positive, fontSize: 34 },
    errorMark: { fontFamily: fontFamily.bodySemiBold, color: colors.danger, fontSize: 34 },
    hash: { fontFamily: fontFamily.address, fontSize: 12, color: colors.textMuted, alignSelf: 'stretch', textAlign: 'center' },
  });
