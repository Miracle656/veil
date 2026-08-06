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
      setError(cause instanceof Error ? cause.message : String(cause));
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
      const message = cause instanceof Error ? cause.message : String(cause);
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
      setError(cause instanceof Error ? cause.message : String(cause));
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
      setError(cause instanceof Error ? cause.message : String(cause));
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
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.eyebrow}>TIME-LOCKED SUB-ACCOUNT</Text>
      <Text style={styles.title}>Vault</Text>
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
                  placeholderTextColor="#64748b"
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
                <ActivityIndicator color="#fff" />
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
              placeholderTextColor="#64748b"
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
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.btnText}>Attach vault</Text>
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
              <ActivityIndicator color="#6366f1" style={{ marginTop: 16 }} />
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
              placeholderTextColor="#64748b"
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
                <ActivityIndicator color="#fff" />
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
              placeholderTextColor="#64748b"
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
              placeholderTextColor="#64748b"
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
                <ActivityIndicator color="#fff" />
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
                      <Text style={[styles.statusBadge, statusColor(withdrawal, ready)]}>{status}</Text>
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
                          <Text style={styles.btnText}>
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
  );
}

function statusColor(withdrawal: VaultWithdrawal, ready: boolean) {
  if (withdrawal.executed) return { color: '#34d399' };
  if (withdrawal.cancelled) return { color: '#64748b' };
  if (ready) return { color: '#facc15' };
  return { color: '#f1f5f9' };
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.label}>{label.toUpperCase()}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue, mono && styles.mono]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: '#0B0B0F',
    padding: 24,
    gap: 16,
  },
  eyebrow: {
    color: '#6366f1',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    color: '#9BA1A6',
    fontSize: 15,
    lineHeight: 21,
  },
  form: {
    gap: 16,
  },
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 16,
    gap: 4,
    borderWidth: 1,
    borderColor: '#334155',
  },
  withdrawalCard: {
    gap: 8,
  },
  sectionTitle: {
    color: '#f1f5f9',
    fontSize: 16,
    fontWeight: '700',
  },
  sectionCopy: {
    color: '#94a3b8',
    fontSize: 13,
    lineHeight: 18,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 10,
  },
  inputFlex: {
    flex: 1,
  },
  inputAsset: {
    flex: 1,
  },
  label: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
    marginTop: 10,
  },
  input: {
    backgroundColor: '#0f172a',
    borderRadius: 10,
    padding: 14,
    color: '#f1f5f9',
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  mono: {
    fontFamily: 'monospace',
    fontSize: 12,
  },
  unitToggle: {
    flexDirection: 'row',
    backgroundColor: '#0f172a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    overflow: 'hidden',
  },
  unitOption: {
    flex: 1,
    paddingVertical: 14,
    alignItems: 'center',
  },
  unitOptionActive: {
    backgroundColor: '#6366f1',
  },
  unitOptionText: {
    color: '#f1f5f9',
    fontSize: 14,
    fontWeight: '600',
  },
  btn: {
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnPrimary: {
    backgroundColor: '#6366f1',
  },
  btnSecondary: {
    backgroundColor: '#334155',
  },
  btnDisabled: {
    opacity: 0.4,
  },
  btnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  withdrawalBtn: {
    flex: 1,
  },
  address: {
    color: '#a5b4fc',
    fontFamily: 'monospace',
    fontSize: 12,
    marginTop: 2,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
    marginTop: 14,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#0f172a',
  },
  stat: {
    minWidth: 100,
  },
  statValue: {
    color: '#f1f5f9',
    fontFamily: 'monospace',
    fontSize: 15,
    marginTop: 2,
  },
  error: {
    color: '#f87171',
    fontSize: 13,
    backgroundColor: '#450a0a',
    borderRadius: 8,
    padding: 12,
  },
  notice: {
    color: '#34d399',
    fontSize: 13,
    backgroundColor: '#052e1f',
    borderRadius: 8,
    padding: 12,
  },
  remove: {
    color: '#f87171',
    fontSize: 13,
  },
  refresh: {
    color: '#a5b4fc',
    fontSize: 13,
  },
  idBadge: {
    color: '#f1f5f9',
    fontSize: 11,
    fontWeight: '700',
    backgroundColor: '#334155',
    borderRadius: 100,
    paddingHorizontal: 10,
    paddingVertical: 4,
    overflow: 'hidden',
  },
  statusBadge: {
    fontSize: 12,
    fontWeight: '700',
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  infoLabel: {
    color: '#64748b',
    fontSize: 12,
    flexShrink: 0,
  },
  infoValue: {
    color: '#f1f5f9',
    fontSize: 12,
    textAlign: 'right',
    flexShrink: 1,
  },
});
