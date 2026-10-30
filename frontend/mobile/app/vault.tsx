import { errorMessage } from '../lib/errorMessage';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  cancelVaultWithdrawal,
  deployAndInitializeVault,
  depositToVault,
  executeVaultWithdrawal,
  fetchVaultDetails,
  formatCountdown,
  formatDelay,
  formatTimestamp,
  isWithdrawalPending,
  isWithdrawalReady,
  parseDelaySeconds,
  queueVaultWithdrawal,
  withdrawalStatus,
  type VaultDetails,
  type VaultFetch,
  type VaultSubmit,
  type VaultTxResult,
  type VaultWithdrawal,
} from '../lib/vault';

import { SafeAreaView } from 'react-native-safe-area-context';

import { FlowHeader } from '../components/FlowHeader';
import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';

type DelayUnit = 'hours' | 'days';

/**
 * Stub submitter — mobile does not yet have the passkey/session signing
 * infrastructure the web wallet uses (see frontend/wallet/lib/passkeyAuth).
 * Replace this with a real signer once device-key or session-based signing
 * lands on mobile. It returns a fake hash so the UI flow can be exercised.
 */
const stubSubmitVaultTx: VaultSubmit = async (call) => {
  await new Promise((resolve) => setTimeout(resolve, 400));
  return { hash: `stub-${call.method}-${Date.now().toString(36)}` } satisfies VaultTxResult;
};

/**
 * Stub reader — replace with a Soroban RPC-backed implementation (mirroring
 * frontend/wallet/lib/vault.ts fetchVaultDetails) once mobile has network
 * config wired up. Returns a deterministic empty vault so the screen renders.
 */
const stubFetchVaultDetails: VaultFetch = async (contractId) => {
  await new Promise((resolve) => setTimeout(resolve, 400));
  return {
    contractId,
    config: { owner: '', token: '', delaySeconds: 86_400 },
    balanceStroops: 0n,
    balanceXlm: '0',
    reservedStroops: 0n,
    reservedXlm: '0',
    availableStroops: 0n,
    availableXlm: '0',
    withdrawals: [],
  } satisfies VaultDetails;
};

export default function VaultScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [contractId, setContractId] = useState<string | null>(null);
  const [details, setDetails] = useState<VaultDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1_000));

  const [delayValue, setDelayValue] = useState('24');
  const [delayUnit, setDelayUnit] = useState<DelayUnit>('hours');
  const [existingContract, setExistingContract] = useState('');
  const [depositAmount, setDepositAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const [withdrawalAmount, setWithdrawalAmount] = useState('');

  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1_000)), 1_000);
    return () => clearInterval(timer);
  }, []);

  const loadDetails = async (address?: string) => {
    const target = address || contractId;
    if (!target) return;

    setLoading(true);
    setError(null);
    try {
      const next = await fetchVaultDetails(target, stubFetchVaultDetails);
      setDetails(next);
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (contractId) void loadDetails(contractId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractId]);

  const pendingWithdrawals = useMemo(
    () => details?.withdrawals ?? [],
    [details],
  );

  async function runAction(name: string, operation: () => Promise<VaultTxResult | string>): Promise<boolean> {
    setAction(name);
    setError(null);
    setNotice(null);
    try {
      const result = await operation();
      const hash = typeof result === 'string' ? result : result.hash;
      setNotice(`Transaction submitted: ${hash.slice(0, 16)}...`);
      await loadDetails();
      return true;
    } catch (cause: unknown) {
      const message = errorMessage(cause);
      setError(message);
      return false;
    } finally {
      setAction(null);
    }
  }

  async function handleDeploy(): Promise<void> {
    let parsedDelay: number;
    try {
      parsedDelay = parseDelaySeconds(delayValue, delayUnit);
    } catch (cause: unknown) {
      setError(errorMessage(cause));
      return;
    }

    await runAction('deploy', async () => {
      const hash = await deployAndInitializeVault({ delaySeconds: parsedDelay }, stubSubmitVaultTx);
      // The stub does not return a real contract id; in production this would
      // come back from the deploy transaction result the same way the web
      // wallet extracts it in frontend/wallet/lib/vault.ts (extractContractId).
      const address = `C-stub-${Date.now().toString(36)}`;
      setContractId(address);
      return hash;
    });
  }

  async function handleAttach(): Promise<void> {
    setAction('attach');
    setError(null);
    try {
      const next = await fetchVaultDetails(existingContract, stubFetchVaultDetails);
      setDetails(next);
      setContractId(next.contractId);
      setExistingContract('');
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    } finally {
      setAction(null);
    }
  }

  async function handleDeposit(): Promise<void> {
    if (!contractId) return;
    const succeeded = await runAction('deposit', () => depositToVault(
      { contractId, amountXlm: depositAmount },
      stubSubmitVaultTx,
    ));
    if (succeeded) setDepositAmount('');
  }

  async function handleQueue(): Promise<void> {
    if (!contractId) return;
    const succeeded = await runAction('queue', () => queueVaultWithdrawal(
      { contractId, to: recipient, amountXlm: withdrawalAmount },
      stubSubmitVaultTx,
    ));
    if (succeeded) {
      setRecipient('');
      setWithdrawalAmount('');
    }
  }

  function handleCancel(withdrawal: VaultWithdrawal): void {
    if (!contractId) return;
    void runAction(`cancel-${withdrawal.id}`, () => cancelVaultWithdrawal(
      { contractId, withdrawalId: withdrawal.id },
      stubSubmitVaultTx,
    ));
  }

  function handleExecute(withdrawal: VaultWithdrawal): void {
    if (!contractId) return;
    void runAction(`execute-${withdrawal.id}`, () => executeVaultWithdrawal(
      { contractId, withdrawalId: withdrawal.id },
      stubSubmitVaultTx,
    ));
  }

  function forgetVault(): void {
    Alert.alert('Remove vault?', 'Funds remain on-chain — you can re-attach this vault later.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          setContractId(null);
          setDetails(null);
          setNotice(null);
          setError(null);
        },
      },
    ]);
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="vault-screen">
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.body}>
      <FlowHeader title="Vault" />
      <Text style={styles.eyebrow}>TIME-LOCKED SUB-ACCOUNT</Text>
      <Text style={styles.subtitle}>
        Hold XLM behind a withdrawal delay. Every transfer must be queued, remains
        cancellable, and can execute only after its timer expires.
      </Text>

      {error && <Text style={styles.error}>{error}</Text>}
      {notice && <Text style={styles.notice}>{notice}</Text>}

      {!contractId ? (
        <View style={styles.form}>
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Create a vault</Text>
            <Text style={styles.sectionCopy}>
              The active account becomes the owner. The delay is fixed for this vault
              after deployment.
            </Text>

            <View style={styles.row}>
              <View style={styles.inputFlex}>
                <Text style={styles.label}>DELAY</Text>
                <TextInput
                  style={styles.input}
                  keyboardType="number-pad"
                  value={delayValue}
                  onChangeText={setDelayValue}
                  placeholderTextColor={colors.textFaint}
                />
              </View>
              <View style={styles.inputAsset}>
                <Text style={styles.label}>UNIT</Text>
                <View style={styles.unitToggle}>
                  <Pressable
                    style={[styles.unitOption, delayUnit === 'hours' && styles.unitOptionActive]}
                    onPress={() => setDelayUnit('hours')}
                  >
                    <Text style={styles.unitOptionText}>Hours</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.unitOption, delayUnit === 'days' && styles.unitOptionActive]}
                    onPress={() => setDelayUnit('days')}
                  >
                    <Text style={styles.unitOptionText}>Days</Text>
                  </Pressable>
                </View>
              </View>
            </View>

            <Pressable
              style={[styles.btn, styles.btnPrimary, action !== null && styles.btnDisabled]}
              onPress={handleDeploy}
              disabled={action !== null}
            >
              {action === 'deploy' ? (
                <ActivityIndicator color={colors.onAccent} />
              ) : (
                <Text style={styles.btnText}>Deploy vault</Text>
              )}
            </Pressable>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Use an existing vault</Text>
            <Text style={styles.sectionCopy}>
              Attach a vault already deployed on the selected Stellar network.
            </Text>
            <TextInput
              style={[styles.input, styles.mono, { marginTop: 12 }]}
              placeholder="C..."
              placeholderTextColor={colors.textFaint}
              value={existingContract}
              onChangeText={(value) => setExistingContract(value.trim())}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Pressable
              style={[
                styles.btn,
                styles.btnSecondary,
                { marginTop: 10 },
                (action !== null || existingContract.length === 0) && styles.btnDisabled,
              ]}
              onPress={handleAttach}
              disabled={action !== null || existingContract.length === 0}
            >
              {action === 'attach' ? (
                <ActivityIndicator color={colors.textPrimary} />
              ) : (
                <Text style={styles.btnSecondaryText}>Attach vault</Text>
              )}
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.form}>
          <View style={styles.card}>
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>VAULT CONTRACT</Text>
                <Text style={styles.address} numberOfLines={1}>{contractId}</Text>
              </View>
              <Pressable onPress={forgetVault}>
                <Text style={styles.remove}>Remove</Text>
              </Pressable>
            </View>

            {loading && !details ? (
              <ActivityIndicator color={colors.accent} style={styles.spinner} />
            ) : details && (
              <>
                <View style={styles.statsGrid}>
                  <Stat label="Total balance" value={`${details.balanceXlm} XLM`} />
                  <Stat label="Available" value={`${details.availableXlm} XLM`} />
                  <Stat label="Queued" value={`${details.reservedXlm} XLM`} />
                  <Stat label="Delay" value={formatDelay(details.config.delaySeconds)} />
                </View>
                <View style={{ marginTop: 12 }}>
                  <Text style={styles.label}>OWNER</Text>
                  <Text style={styles.address}>{details.config.owner || 'Unknown'}</Text>
                </View>
              </>
            )}
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Deposit XLM</Text>
            <Text style={styles.sectionCopy}>Move XLM from the active account into this vault.</Text>
            <Text style={styles.label}>AMOUNT</Text>
            <TextInput
              style={styles.input}
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor={colors.textFaint}
              value={depositAmount}
              onChangeText={setDepositAmount}
            />
            <Pressable
              style={[
                styles.btn,
                styles.btnPrimary,
                { marginTop: 10 },
                (action !== null || depositAmount.length === 0) && styles.btnDisabled,
              ]}
              onPress={handleDeposit}
              disabled={action !== null || depositAmount.length === 0}
            >
              {action === 'deposit' ? (
                <ActivityIndicator color={colors.onAccent} />
              ) : (
                <Text style={styles.btnText}>Deposit</Text>
              )}
            </Pressable>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Queue withdrawal</Text>
            <Text style={styles.sectionCopy}>
              The destination and amount cannot change after queueing.
            </Text>
            <Text style={styles.label}>DESTINATION</Text>
            <TextInput
              style={[styles.input, styles.mono]}
              placeholder="G... or C..."
              placeholderTextColor={colors.textFaint}
              value={recipient}
              onChangeText={(value) => setRecipient(value.trim())}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={[styles.label, { marginTop: 10 }]}>AMOUNT</Text>
            <TextInput
              style={styles.input}
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor={colors.textFaint}
              value={withdrawalAmount}
              onChangeText={setWithdrawalAmount}
            />
            <Pressable
              style={[
                styles.btn,
                styles.btnPrimary,
                { marginTop: 10 },
                (action !== null || recipient.length === 0 || withdrawalAmount.length === 0)
                  && styles.btnDisabled,
              ]}
              onPress={handleQueue}
              disabled={action !== null || recipient.length === 0 || withdrawalAmount.length === 0}
            >
              {action === 'queue' ? (
                <ActivityIndicator color={colors.onAccent} />
              ) : (
                <Text style={styles.btnText}>Queue withdrawal</Text>
              )}
            </Pressable>
          </View>

          <View>
            <View style={[styles.row, { alignItems: 'center', marginBottom: 10 }]}>
              <Text style={styles.sectionTitle}>Withdrawal queue</Text>
              <Pressable onPress={() => loadDetails()} disabled={loading || action !== null}>
                <Text style={styles.refresh}>{loading ? 'Refreshing...' : 'Refresh'}</Text>
              </Pressable>
            </View>

            {pendingWithdrawals.length === 0 ? (
              <View style={styles.card}>
                <Text style={styles.sectionCopy}>No withdrawals have been queued.</Text>
              </View>
            ) : (
              pendingWithdrawals.map((withdrawal) => {
                const pending = isWithdrawalPending(withdrawal);
                const ready = isWithdrawalReady(withdrawal, now);
                const status = withdrawalStatus(withdrawal, now);
                const busy = action === `cancel-${withdrawal.id}` || action === `execute-${withdrawal.id}`;

                return (
                  <View key={withdrawal.id} style={[styles.card, styles.withdrawalCard]}>
                    <View style={styles.row}>
                      <Text style={styles.idBadge}>Withdrawal #{withdrawal.id}</Text>
                      <Text style={[styles.statusBadge, statusColor(withdrawal, ready, colors)]}>{status}</Text>
                    </View>

                    <InfoRow label="Amount" value={`${withdrawal.amountXlm} XLM`} />
                    <InfoRow label="Destination" value={withdrawal.to} mono />
                    <InfoRow label="Queued" value={formatTimestamp(withdrawal.queuedAt)} />
                    <InfoRow
                      label="Unlocks"
                      value={pending
                        ? `${formatTimestamp(withdrawal.unlockAt)} (${formatCountdown(withdrawal.unlockAt, now)})`
                        : formatTimestamp(withdrawal.unlockAt)}
                    />

                    {pending && (
                      <View style={styles.row}>
                        <Pressable
                          style={[styles.btn, styles.btnSecondary, styles.withdrawalBtn, action !== null && styles.btnDisabled]}
                          disabled={action !== null}
                          onPress={() => handleCancel(withdrawal)}
                        >
                          <Text style={styles.btnSecondaryText}>
                            {action === `cancel-${withdrawal.id}` ? 'Cancelling...' : 'Cancel'}
                          </Text>
                        </Pressable>
                        {ready && (
                          <Pressable
                            style={[styles.btn, styles.btnPrimary, styles.withdrawalBtn, action !== null && styles.btnDisabled]}
                            disabled={action !== null}
                            onPress={() => handleExecute(withdrawal)}
                          >
                            <Text style={styles.btnText}>
                              {action === `execute-${withdrawal.id}` ? 'Executing...' : 'Execute'}
                            </Text>
                          </Pressable>
                        )}
                      </View>
                    )}

                    {busy && <Text style={styles.sectionCopy}>Waiting for Stellar confirmation...</Text>}
                  </View>
                );
              })
            )}
          </View>
        </View>
      )}
    </ScrollView>
    </SafeAreaView>
  );
}

/**
 * The queue's four states, in palette roles rather than four loose hexes.
 *
 * Executed is the positive token the rest of the app uses for money arriving;
 * cancelled is muted because it is over and nothing is owed; ready is the
 * accent, since it is the only one of the four asking to be acted on.
 */
function statusColor(withdrawal: VaultWithdrawal, ready: boolean, colors: ThemeColors) {
  if (withdrawal.executed) return { color: colors.positive };
  if (withdrawal.cancelled) return { color: colors.textMuted };
  if (ready) return { color: colors.accentText };
  return { color: colors.textPrimary };
}

function Stat({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.stat}>
      <Text style={styles.label}>{label.toUpperCase()}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue, mono && styles.mono]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

/**
 * The vault was the last screen still drawing the indigo/slate palette the app
 * left behind — 41 hardcoded values, dark-only, with `fontFamily: 'monospace'`
 * standing in for Inconsolata and four loose hexes deciding what a withdrawal's
 * status looked like. In light mode it was a dark slab; in dark mode it was a
 * different dark from everything around it.
 *
 * Roles, not hexes, so both palettes come from one definition. `surfaceMd` is
 * the inset fill (inputs, the stats grid) and `surface` the card above it,
 * which keeps the nesting legible without inventing a third background.
 */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    body: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 16, paddingBottom: 40, gap: 14 },

    eyebrow: {
      color: colors.accentText,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 11,
      letterSpacing: 1.4,
      textTransform: 'uppercase',
      marginTop: 10,
    },
    subtitle: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 14.5,
      lineHeight: 21,
    },

    form: { gap: 16 },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      paddingHorizontal: 16,
      paddingVertical: 14,
      gap: 4,
      borderWidth: 1,
      borderColor: colors.border,
    },
    withdrawalCard: { gap: 8 },
    sectionTitle: {
      color: colors.textStrong,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 16,
    },
    sectionCopy: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
    },
    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      gap: 10,
    },
    inputFlex: { flex: 1 },
    inputAsset: { flex: 1 },
    label: {
      color: colors.textFaint,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: 1.4,
      marginBottom: 6,
      marginTop: 10,
    },
    input: {
      backgroundColor: colors.surfaceMd,
      borderRadius: 14,
      paddingHorizontal: 14,
      paddingVertical: 13,
      color: colors.textPrimary,
      fontFamily: fontFamily.body,
      fontSize: 16,
      borderWidth: 1,
      // borderStrong, not border: a field being asked for has to be visible as
      // one, and the faint divider colour made these disappear on white.
      borderColor: colors.borderStrong,
    },
    mono: { fontFamily: fontFamily.address, fontSize: 12 },

    unitToggle: {
      flexDirection: 'row',
      backgroundColor: colors.surfaceMd,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      overflow: 'hidden',
    },
    unitOption: { flex: 1, paddingVertical: 14, alignItems: 'center' },
    unitOptionActive: { backgroundColor: colors.accent },
    unitOptionText: {
      color: colors.textPrimary,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 14,
    },

    btn: {
      borderRadius: 100,
      paddingVertical: 15,
      alignItems: 'center',
      justifyContent: 'center',
    },
    btnPrimary: { backgroundColor: colors.accent },
    btnSecondary: {
      backgroundColor: colors.surfaceMd,
      borderWidth: 1,
      borderColor: colors.border,
    },
    btnDisabled: { opacity: 0.4 },
    btnText: { color: colors.onAccent, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },
    // A secondary button is not drawn on the accent, so its label cannot use
    // the on-accent colour: on light mode that was near-white on near-white.
    btnSecondaryText: {
      color: colors.textPrimary,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
    },
    withdrawalBtn: { flex: 1 },

    address: {
      color: colors.accentText,
      fontFamily: fontFamily.address,
      fontSize: 12,
      marginTop: 2,
    },
    statsGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 16,
      marginTop: 14,
      padding: 12,
      borderRadius: 14,
      backgroundColor: colors.surfaceMd,
    },
    stat: { minWidth: 100 },
    statValue: {
      color: colors.textPrimary,
      fontFamily: fontFamily.address,
      fontSize: 15,
      marginTop: 2,
    },
    spinner: { marginTop: 16 },

    error: {
      color: colors.danger,
      backgroundColor: colors.dangerSurface,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
      borderRadius: 12,
      padding: 12,
    },
    notice: {
      color: colors.positive,
      backgroundColor: colors.positiveSurface,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
      borderRadius: 12,
      padding: 12,
    },
    remove: { color: colors.danger, fontFamily: fontFamily.body, fontSize: 13 },
    refresh: { color: colors.accentText, fontFamily: fontFamily.body, fontSize: 13 },

    idBadge: {
      color: colors.textPrimary,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 11,
      backgroundColor: colors.surfaceMd,
      borderRadius: 100,
      paddingHorizontal: 10,
      paddingVertical: 4,
      overflow: 'hidden',
    },
    statusBadge: { fontFamily: fontFamily.bodySemiBold, fontSize: 12 },
    infoRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
    infoLabel: {
      color: colors.textFaint,
      fontFamily: fontFamily.body,
      fontSize: 12,
      flexShrink: 0,
    },
    infoValue: {
      color: colors.textPrimary,
      fontFamily: fontFamily.body,
      fontSize: 12,
      textAlign: 'right',
      flexShrink: 1,
    },
  });
