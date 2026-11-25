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
import { useRouter } from 'expo-router';

import { FlowHeader } from '../components/FlowHeader';
import { AddressChip } from '../components/ui/AddressChip';
import { Button, Card, Screen } from '../components/ui';
import { useHiddenAmounts } from '../hooks/useHiddenAmounts';
import { useNetwork } from '../hooks/useNetwork';
import { useTheme } from '../hooks/useTheme';
import { getDefindexVaultConfig } from '../config/defindex';
import {
  STROOPS_PER_UNIT,
  buildDefindexDepositXdr,
  buildDefindexWithdrawXdr,
  formatBps,
  loadDefindexUserPosition,
  loadDefindexVaultState,
  parseToStroops,
  saveCurrentStrategies,
  submitDefindexTransaction,
  type DefindexUserPosition,
  type DefindexVaultState,
} from '../lib/defindex';
import { loadEarnBalances } from '../lib/earnFunding';
import { errorMessage } from '../lib/errorMessage';
import { requirePasskey } from '../lib/passkey';
import { isPasskeyCancellation } from '../lib/passkeyOutcome';
import type { ThemeColors } from '../lib/theme';
import { getWalletAddress } from '../lib/walletStore';
import { fontFamily, typography } from '../theme/typography';

type ActiveTab = 'deposit' | 'withdraw';

export default function DefindexVaultScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { mask } = useHiddenAmounts();
  const { network } = useNetwork();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const config = useMemo(() => getDefindexVaultConfig(network.name), [network.name]);

  const [vaultState, setVaultState] = useState<DefindexVaultState | null>(null);
  const [position, setPosition] = useState<DefindexUserPosition | null>(null);
  const [userAddress, setUserAddress] = useState<string | null>(null);
  const [availableUsdc, setAvailableUsdc] = useState<number | null>(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>('deposit');

  const [depositInput, setDepositInput] = useState('');
  const [withdrawInput, setWithdrawInput] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      setErrorMsg(null);
      const addr = await getWalletAddress().catch(() => null);
      setUserAddress(addr);

      const [vault, pos, balances] = await Promise.all([
        loadDefindexVaultState(config.vaultAddress, network.rpcUrl, network.networkPassphrase),
        addr
          ? loadDefindexUserPosition(
              config.vaultAddress,
              addr,
              network.rpcUrl,
              network.networkPassphrase,
            )
          : null,
        loadEarnBalances('USDC').catch(() => null),
      ]);

      setVaultState(vault);
      setPosition(pos);
      if (balances) {
        setAvailableUsdc(balances.inSpending + balances.inWallet);
      }
    } catch (err: unknown) {
      setErrorMsg(errorMessage(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [config.vaultAddress, network.rpcUrl, network.networkPassphrase]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    loadData();
  }, [loadData]);

  // Calculations for deposit
  const parsedDepositAmount = useMemo(() => {
    try {
      return depositInput ? parseToStroops(depositInput) : 0n;
    } catch {
      return 0n;
    }
  }, [depositInput]);

  const estimatedShares = useMemo(() => {
    if (!vaultState || parsedDepositAmount <= 0n) return '0.00';
    if (vaultState.sharePrice <= 0) return '0.00';
    const sharesNum = Number(parsedDepositAmount) / Number(STROOPS_PER_UNIT) / vaultState.sharePrice;
    return sharesNum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }, [vaultState, parsedDepositAmount]);

  // Calculations for withdraw
  const parsedWithdrawShares = useMemo(() => {
    try {
      return withdrawInput ? parseToStroops(withdrawInput) : 0n;
    } catch {
      return 0n;
    }
  }, [withdrawInput]);

  const estimatedUnderlyingReturn = useMemo(() => {
    if (!vaultState || parsedWithdrawShares <= 0n) return '0.00';
    const underlyingNum = (Number(parsedWithdrawShares) / Number(STROOPS_PER_UNIT)) * vaultState.sharePrice;
    return underlyingNum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }, [vaultState, parsedWithdrawShares]);

  const maxSharesNum = position ? Number(position.shares) / Number(STROOPS_PER_UNIT) : 0;
  const isWithdrawOverBalance =
    position && parsedWithdrawShares > position.shares;

  async function handleDeposit() {
    if (!userAddress || parsedDepositAmount <= 0n) return;
    setSubmitting(true);
    setProgressMessage('Waiting for passkey…');
    setErrorMsg(null);
    setTxHash(null);

    try {
      await requirePasskey();
      setProgressMessage('Building deposit transaction…');

      const unsignedXdr = await buildDefindexDepositXdr({
        vaultAddress: config.vaultAddress,
        userAddress,
        amountStroops: parsedDepositAmount,
      });

      setProgressMessage('Signing with passkey and fee payer…');
      const hash = await submitDefindexTransaction(unsignedXdr);

      setTxHash(hash);
      setDepositInput('');

      // Save strategies to track subsequent manager rebalancing
      if (vaultState?.strategies) {
        await saveCurrentStrategies(
          config.vaultAddress,
          vaultState.strategies.map((s) => s.address),
        );
      }

      await loadData();
    } catch (err: unknown) {
      if (isPasskeyCancellation(err)) {
        setErrorMsg(null);
        return;
      }
      setErrorMsg(errorMessage(err));
    } finally {
      setSubmitting(false);
      setProgressMessage(null);
    }
  }

  async function handleWithdraw() {
    if (!userAddress || parsedWithdrawShares <= 0n || isWithdrawOverBalance) return;
    setSubmitting(true);
    setProgressMessage('Waiting for passkey…');
    setErrorMsg(null);
    setTxHash(null);

    try {
      await requirePasskey();
      setProgressMessage('Building withdrawal transaction…');

      const unsignedXdr = await buildDefindexWithdrawXdr({
        vaultAddress: config.vaultAddress,
        userAddress,
        shareAmountStroops: parsedWithdrawShares,
      });

      setProgressMessage('Signing with passkey and fee payer…');
      const hash = await submitDefindexTransaction(unsignedXdr);

      setTxHash(hash);
      setWithdrawInput('');
      await loadData();
    } catch (err: unknown) {
      if (isPasskeyCancellation(err)) {
        setErrorMsg(null);
        return;
      }
      setErrorMsg(errorMessage(err));
    } finally {
      setSubmitting(false);
      setProgressMessage(null);
    }
  }

  return (
    <Screen padded={false}>
      <FlowHeader title="DeFindex Vault" onBack={() => router.back()} />

      <KeyboardAvoidingView
        style={styles.keyboardContainer}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {loading && !refreshing ? (
          <View style={styles.centerLoading}>
            <ActivityIndicator color={colors.accent} size="large" />
            <Text style={styles.loadingText}>Loading vault on {network.displayName}…</Text>
          </View>
        ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.accent} />}
        >
          {/* Header Card / Info */}
          <Card style={styles.card}>
            <View style={styles.rowBetween}>
              <View>
                <Text style={[typography.heading, styles.vaultTitle]}>DeFindex USDC Vault</Text>
                <Text style={styles.subtitle}>Automated yield aggregator on Stellar</Text>
              </View>
              <Text style={styles.badge}>DeFindex</Text>
            </View>

            <View style={styles.separator} />

            {/* Manager Address */}
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Vault Manager</Text>
              {vaultState?.manager ? (
                <AddressChip address={vaultState.manager} />
              ) : (
                <Text style={styles.metaValue}>Unspecified</Text>
              )}
            </View>

            {/* Emergency Manager */}
            {vaultState?.emergencyManager ? (
              <View style={styles.metaRow}>
                <Text style={styles.metaLabel}>Emergency Manager</Text>
                <AddressChip address={vaultState.emergencyManager} />
              </View>
            ) : null}

            {/* Single Strategy Notice */}
            {vaultState?.singleStrategyNotice ? (
              <View style={styles.singleStrategyBanner}>
                <Text style={styles.singleStrategyText}>
                  ℹ️ {vaultState.singleStrategyNotice}
                </Text>
              </View>
            ) : null}

            {/* Strategy Allocation List */}
            <View style={styles.strategySection}>
              <Text style={[typography.accent, styles.sectionHeader]}>Strategy Allocations</Text>
              {vaultState?.strategies && vaultState.strategies.length > 0 ? (
                vaultState.strategies.map((st) => (
                  <View key={st.address} style={styles.strategyItem}>
                    <View style={styles.strategyInfo}>
                      <Text style={styles.strategyName}>{st.name}</Text>
                      <AddressChip address={st.address} />
                    </View>
                    <View style={styles.strategyRight}>
                      <Text style={styles.strategyShare}>{st.percentage.toFixed(1)}%</Text>
                      {st.paused ? (
                        <Text style={styles.pausedBadge}>PAUSED</Text>
                      ) : (
                        <Text style={styles.activeBadge}>Active</Text>
                      )}
                    </View>
                  </View>
                ))
              ) : (
                <Text style={styles.metaValue}>No active strategies listed</Text>
              )}
            </View>
          </Card>

          {/* Strategy Drift Alert */}
          {vaultState?.driftDetected ? (
            <View style={styles.driftBanner}>
              <Text style={styles.driftTitle}>⚠️ Strategy Allocation Updated</Text>
              <Text style={styles.driftText}>
                The vault manager has rebalanced strategies since you last viewed or deposited into this vault. The allocations above reflect the live on-chain distribution.
              </Text>
            </View>
          ) : null}

          {/* Paused Banner */}
          {vaultState?.isPaused ? (
            <View style={styles.pausedBanner}>
              <Text style={styles.pausedBannerTitle}>⛔ Vault Paused</Text>
              <Text style={styles.pausedBannerText}>
                This vault has been paused by the emergency manager. Deposits and withdrawals are temporarily halted.
              </Text>
            </View>
          ) : null}

          {/* Emptied Banner */}
          {vaultState?.isEmptied ? (
            <View style={styles.emptiedBanner}>
              <Text style={styles.emptiedBannerText}>
                ⚠️ This vault currently holds 0 TVL (emptied position).
              </Text>
            </View>
          ) : null}

          {/* User Position Card */}
          <Card style={styles.card}>
            <Text style={[typography.accent, styles.sectionHeader]}>Your Vault Position</Text>
            <View style={styles.rowBetween}>
              <View>
                <Text style={styles.muted}>Share Balance</Text>
                <Text style={styles.positionValue}>
                  {position && position.shares > 0n
                    ? `${mask(position.sharesFormatted)} dfUSDC`
                    : '0.00 dfUSDC'}
                </Text>
              </View>
              <View style={styles.alignRight}>
                <Text style={styles.muted}>Underlying Value</Text>
                <Text style={styles.positionValue}>
                  {position && position.shares > 0n
                    ? `${mask(position.underlyingFormatted)} USDC`
                    : '$0.00 USDC'}
                </Text>
              </View>
            </View>

            <View style={styles.separator} />

            <View style={styles.rowBetween}>
              <Text style={styles.muted}>Current Share Price</Text>
              <Text style={styles.sharePriceText}>
                1 dfUSDC = {(vaultState?.sharePrice ?? 1.0).toFixed(4)} USDC
              </Text>
            </View>

            {position && position.shares === 0n ? (
              <View style={styles.zeroShareState}>
                <Text style={styles.zeroShareText}>
                  You have no shares in this vault. Deposit USDC below to begin earning yield.
                </Text>
              </View>
            ) : null}
          </Card>

          {/* Fees Card */}
          <Card style={styles.card}>
            <Text style={[typography.accent, styles.sectionHeader]}>Fee Breakdown</Text>
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Vault Performance Fee</Text>
              <Text style={styles.feeNumber}>
                {vaultState ? formatBps(vaultState.vaultFeeBps) : '18.09%'} of yield
              </Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Veil Platform Fee</Text>
              <Text style={styles.feeNumber}>
                {vaultState ? formatBps(vaultState.veilFeeBps) : '0.00%'}
              </Text>
            </View>
            <Text style={styles.footnote}>
              DeFindex charges a performance fee only on accrued yield, with zero deposit or withdrawal fees. Veil takes 0.00%.
            </Text>
          </Card>

          {/* Deposit / Withdraw Action Card */}
          <Card style={styles.card}>
            <View style={styles.tabContainer}>
              <Pressable
                style={[styles.tabButton, activeTab === 'deposit' && styles.tabButtonActive]}
                onPress={() => setActiveTab('deposit')}
              >
                <Text style={[styles.tabText, activeTab === 'deposit' && styles.tabTextActive]}>
                  Deposit
                </Text>
              </Pressable>
              <Pressable
                style={[styles.tabButton, activeTab === 'withdraw' && styles.tabButtonActive]}
                onPress={() => setActiveTab('withdraw')}
              >
                <Text style={[styles.tabText, activeTab === 'withdraw' && styles.tabTextActive]}>
                  Withdraw
                </Text>
              </Pressable>
            </View>

            {activeTab === 'deposit' ? (
              <View style={styles.formContainer}>
                <Text style={styles.inputLabel}>Deposit Amount (USDC)</Text>
                <View style={styles.inputRow}>
                  <TextInput
                    style={styles.input}
                    value={depositInput}
                    onChangeText={setDepositInput}
                    placeholder="0.00"
                    placeholderTextColor={colors.textFaint}
                    keyboardType="decimal-pad"
                    editable={!submitting && !vaultState?.isPaused}
                  />
                  {availableUsdc !== null ? (
                    <Pressable
                      style={styles.maxButton}
                      onPress={() => setDepositInput(availableUsdc.toFixed(2))}
                    >
                      <Text style={styles.maxText}>MAX</Text>
                    </Pressable>
                  ) : null}
                </View>

                {availableUsdc !== null ? (
                  <Text style={styles.balanceHint}>
                    Available in wallet: {mask(availableUsdc.toFixed(2))} USDC
                  </Text>
                ) : null}

                {parsedDepositAmount > 0n ? (
                  <Text style={styles.estimateText}>
                    Estimated shares to receive: ≈ {estimatedShares} dfUSDC
                  </Text>
                ) : null}

                <Button
                  label={vaultState?.isPaused ? 'Vault Paused' : 'Deposit USDC'}
                  variant="gold"
                  disabled={
                    submitting ||
                    vaultState?.isPaused ||
                    parsedDepositAmount <= 0n ||
                    (availableUsdc !== null && Number(depositInput) > availableUsdc)
                  }
                  onPress={handleDeposit}
                />
              </View>
            ) : (
              <View style={styles.formContainer}>
                <Text style={styles.inputLabel}>Withdraw Shares (dfUSDC)</Text>
                <View style={styles.inputRow}>
                  <TextInput
                    style={styles.input}
                    value={withdrawInput}
                    onChangeText={setWithdrawInput}
                    placeholder="0.00"
                    placeholderTextColor={colors.textFaint}
                    keyboardType="decimal-pad"
                    editable={!submitting && !vaultState?.isPaused}
                  />
                  {maxSharesNum > 0 ? (
                    <Pressable
                      style={styles.maxButton}
                      onPress={() => setWithdrawInput(maxSharesNum.toFixed(4))}
                    >
                      <Text style={styles.maxText}>MAX</Text>
                    </Pressable>
                  ) : null}
                </View>

                {position ? (
                  <Text style={[styles.balanceHint, isWithdrawOverBalance && styles.errorText]}>
                    Vault shares held: {mask(position.sharesFormatted)} dfUSDC
                  </Text>
                ) : null}

                {parsedWithdrawShares > 0n ? (
                  <Text style={styles.estimateText}>
                    Estimated USDC to receive: ≈ {estimatedUnderlyingReturn} USDC
                  </Text>
                ) : null}

                <Button
                  label={vaultState?.isPaused ? 'Vault Paused' : 'Withdraw dfUSDC'}
                  variant="gold"
                  disabled={
                    submitting ||
                    vaultState?.isPaused ||
                    parsedWithdrawShares <= 0n ||
                    Boolean(isWithdrawOverBalance) ||
                    (position?.shares ?? 0n) <= 0n
                  }
                  onPress={handleWithdraw}
                />
              </View>
            )}

            {/* Submitting progress */}
            {submitting ? (
              <View style={styles.progressContainer}>
                <ActivityIndicator color={colors.accent} size="small" />
                <Text style={styles.progressText}>{progressMessage ?? 'Processing…'}</Text>
              </View>
            ) : null}

            {/* Transaction Hash */}
            {txHash ? (
              <View style={styles.successContainer}>
                <Text style={styles.successTitle}>✓ Transaction Submitted</Text>
                <AddressChip address={txHash} label="View TX Hash" />
              </View>
            ) : null}

            {/* Error Message */}
            {errorMsg ? (
              <View style={styles.errorContainer}>
                <Text style={styles.errorText}>{errorMsg}</Text>
              </View>
            ) : null}
          </Card>
        </ScrollView>
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    keyboardContainer: {
      flex: 1,
    },
    centerLoading: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      gap: 12,
    },
    loadingText: {
      fontSize: 14,
      fontFamily: fontFamily.body,
      color: colors.textSecondary,
    },
    content: {
      padding: 16,
      paddingBottom: 40,
      gap: 16,
    },
    card: {
      padding: 18,
      borderRadius: 16,
      gap: 12,
    },
    rowBetween: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    alignRight: {
      alignItems: 'flex-end',
    },
    vaultTitle: {
      fontSize: 20,
      fontFamily: fontFamily.accent,
      color: colors.textStrong,
    },
    subtitle: {
      fontSize: 13,
      fontFamily: fontFamily.body,
      color: colors.textSecondary,
      marginTop: 2,
    },
    badge: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 8,
      backgroundColor: colors.surfaceMd,
      color: colors.accent,
      fontSize: 12,
      fontFamily: fontFamily.address,
      borderWidth: 1,
      borderColor: colors.border,
    },
    separator: {
      height: 1,
      backgroundColor: colors.border,
      marginVertical: 4,
    },
    metaRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    metaLabel: {
      fontSize: 13,
      fontFamily: fontFamily.body,
      color: colors.textSecondary,
    },
    metaValue: {
      fontSize: 13,
      fontFamily: fontFamily.address,
      color: colors.textPrimary,
    },
    feeNumber: {
      fontSize: 14,
      fontFamily: fontFamily.address,
      color: colors.accent,
      fontWeight: '600',
    },
    singleStrategyBanner: {
      backgroundColor: 'rgba(212, 175, 55, 0.1)',
      borderWidth: 1,
      borderColor: colors.accent,
      borderRadius: 8,
      padding: 10,
      marginVertical: 4,
    },
    singleStrategyText: {
      fontSize: 13,
      fontFamily: fontFamily.body,
      color: colors.accent,
      fontWeight: '600',
    },
    strategySection: {
      gap: 8,
      marginTop: 4,
    },
    sectionHeader: {
      fontSize: 14,
      fontFamily: fontFamily.heading,
      color: colors.textStrong,
      fontStyle: 'italic',
      marginBottom: 2,
    },
    strategyItem: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 6,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    strategyInfo: {
      flex: 1,
      gap: 4,
    },
    strategyName: {
      fontSize: 13,
      fontFamily: fontFamily.body,
      color: colors.textPrimary,
      fontWeight: '500',
    },
    strategyRight: {
      alignItems: 'flex-end',
      gap: 4,
    },
    strategyShare: {
      fontSize: 13,
      fontFamily: fontFamily.address,
      color: colors.textPrimary,
    },
    activeBadge: {
      fontSize: 10,
      color: '#4ade80',
      fontFamily: fontFamily.address,
    },
    pausedBadge: {
      fontSize: 10,
      color: '#f87171',
      fontFamily: fontFamily.address,
      fontWeight: 'bold',
    },
    driftBanner: {
      backgroundColor: 'rgba(251, 191, 36, 0.15)',
      borderWidth: 1,
      borderColor: '#f59e0b',
      borderRadius: 12,
      padding: 14,
      gap: 6,
    },
    driftTitle: {
      fontSize: 14,
      fontFamily: fontFamily.body,
      color: '#f59e0b',
      fontWeight: 'bold',
    },
    driftText: {
      fontSize: 12,
      fontFamily: fontFamily.body,
      color: colors.textPrimary,
      lineHeight: 18,
    },
    pausedBanner: {
      backgroundColor: 'rgba(239, 68, 68, 0.15)',
      borderWidth: 1,
      borderColor: '#ef4444',
      borderRadius: 12,
      padding: 14,
      gap: 6,
    },
    pausedBannerTitle: {
      fontSize: 14,
      fontFamily: fontFamily.body,
      color: '#ef4444',
      fontWeight: 'bold',
    },
    pausedBannerText: {
      fontSize: 12,
      fontFamily: fontFamily.body,
      color: colors.textPrimary,
      lineHeight: 18,
    },
    emptiedBanner: {
      backgroundColor: 'rgba(156, 163, 175, 0.15)',
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      padding: 12,
    },
    emptiedBannerText: {
      fontSize: 12,
      fontFamily: fontFamily.body,
      color: colors.textSecondary,
    },
    positionValue: {
      fontSize: 18,
      fontFamily: fontFamily.address,
      color: colors.textPrimary,
      fontWeight: 'bold',
      marginTop: 2,
    },
    muted: {
      fontSize: 12,
      fontFamily: fontFamily.body,
      color: colors.textSecondary,
    },
    sharePriceText: {
      fontSize: 13,
      fontFamily: fontFamily.address,
      color: colors.accent,
    },
    zeroShareState: {
      backgroundColor: colors.surfaceMd,
      borderRadius: 8,
      padding: 10,
      marginTop: 4,
    },
    zeroShareText: {
      fontSize: 12,
      fontFamily: fontFamily.body,
      color: colors.textSecondary,
      textAlign: 'center',
    },
    footnote: {
      fontSize: 11,
      fontFamily: fontFamily.body,
      color: colors.textFaint,
      lineHeight: 16,
    },
    tabContainer: {
      flexDirection: 'row',
      backgroundColor: colors.surfaceMd,
      borderRadius: 10,
      padding: 4,
      marginBottom: 8,
    },
    tabButton: {
      flex: 1,
      paddingVertical: 8,
      alignItems: 'center',
      borderRadius: 8,
    },
    tabButtonActive: {
      backgroundColor: colors.surface,
    },
    tabText: {
      fontSize: 14,
      fontFamily: fontFamily.body,
      color: colors.textSecondary,
    },
    tabTextActive: {
      color: colors.textPrimary,
      fontWeight: 'bold',
    },
    formContainer: {
      gap: 10,
    },
    inputLabel: {
      fontSize: 13,
      fontFamily: fontFamily.body,
      color: colors.textSecondary,
    },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: 12,
      backgroundColor: colors.surfaceMd,
    },
    input: {
      flex: 1,
      height: 44,
      color: colors.textPrimary,
      fontFamily: fontFamily.address,
      fontSize: 16,
    },
    maxButton: {
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 6,
      backgroundColor: 'rgba(212, 175, 55, 0.2)',
    },
    maxText: {
      fontSize: 11,
      fontFamily: fontFamily.address,
      color: colors.accent,
      fontWeight: 'bold',
    },
    balanceHint: {
      fontSize: 12,
      fontFamily: fontFamily.address,
      color: colors.textSecondary,
    },
    estimateText: {
      fontSize: 12,
      fontFamily: fontFamily.body,
      color: colors.accent,
      marginVertical: 2,
    },
    progressContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      justifyContent: 'center',
      paddingVertical: 8,
    },
    progressText: {
      fontSize: 13,
      fontFamily: fontFamily.body,
      color: colors.textSecondary,
    },
    successContainer: {
      padding: 12,
      borderRadius: 8,
      backgroundColor: 'rgba(74, 222, 128, 0.1)',
      borderWidth: 1,
      borderColor: 'rgba(74, 222, 128, 0.3)',
      gap: 6,
    },
    successTitle: {
      fontSize: 13,
      fontFamily: fontFamily.body,
      color: '#4ade80',
      fontWeight: 'bold',
    },
    errorContainer: {
      padding: 10,
      borderRadius: 8,
      backgroundColor: 'rgba(239, 68, 68, 0.1)',
      borderWidth: 1,
      borderColor: 'rgba(239, 68, 68, 0.3)',
    },
    errorText: {
      fontSize: 12,
      fontFamily: fontFamily.body,
      color: '#ef4444',
    },
  });
