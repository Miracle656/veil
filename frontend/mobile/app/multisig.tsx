/**
 * Multisig coordination — propose, approve, execute.
 *
 * The mobile counterpart to the web wallet's `/multisig` page, minus deployment
 * (a wallet is created once, from the desktop wizard) and plus the whole point
 * of this screen: an owner can raise a transfer, other owners can approve it,
 * and the approval that reaches the threshold executes it.
 *
 * Execution is not a separate step. `contracts/multisig-wallet` performs the
 * transfer inside the invocation that reaches the threshold, so the deciding
 * approval moves the money. The screen labels that approval accordingly rather
 * than offering an Execute button that the contract has no entry point for.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import {
  approvalBlocker,
  approveProposal,
  fetchMultisigDetails,
  fetchProposals,
  formatStroopsAsXlm,
  MULTISIG_CONTRACT_STORAGE_KEY,
  MultisigError,
  proposalStatus,
  proposeTransfer,
  publicKeyFromSecret,
  remainingApprovals,
  willExecuteOnApproval,
  type MultisigDetails,
  type Proposal,
} from '../lib/multisig';

/** AsyncStorage key holding this device's signer secret, mirroring the web wallet's. */
const SIGNER_SECRET_KEY = 'veil_signer_secret';

const STATUS_LABEL = {
  executed: 'Executed',
  ready: 'Threshold met',
  pending: 'Awaiting approvals',
} as const;

/** `GABC…WXYZ` — middle-truncate an address so a full row still fits on a phone. */
function truncate(address: string): string {
  return address.length <= 16 ? address : `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function describe(error: unknown): string {
  if (error instanceof MultisigError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

export default function MultisigScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [contractId, setContractId] = useState<string | null>(null);
  const [contractDraft, setContractDraft] = useState('');
  const [loaded, setLoaded] = useState(false);

  const [details, setDetails] = useState<MultisigDetails | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [signerSecret, setSignerSecret] = useState('');

  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [proposing, setProposing] = useState(false);
  const [proposeError, setProposeError] = useState<string | null>(null);

  const [approvingId, setApprovingId] = useState<number | null>(null);
  const [approveErrors, setApproveErrors] = useState<Record<number, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const signerAddress = useMemo(() => publicKeyFromSecret(signerSecret), [signerSecret]);

  // ── Stored wallet + device signer ────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const [stored, secret] = await Promise.all([
        AsyncStorage.getItem(MULTISIG_CONTRACT_STORAGE_KEY).catch(() => null),
        AsyncStorage.getItem(SIGNER_SECRET_KEY).catch(() => null),
      ]);
      if (cancelled) return;

      setContractId(stored);
      setContractDraft(stored ?? '');
      // Prefilled, not required: this device's key is the common case, but
      // approving on behalf of another owner means pasting a different one.
      if (secret) setSignerSecret(secret);
      setLoaded(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async (id: string) => {
    setRefreshing(true);
    setLoadError(null);
    try {
      // Details first: the threshold is what every proposal's state is read
      // against, so a queue without it would be meaningless.
      const nextDetails = await fetchMultisigDetails(id);
      setDetails(nextDetails);
      setProposals(await fetchProposals(id));
    } catch (error) {
      setDetails(null);
      setProposals([]);
      setLoadError(describe(error));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (contractId) void load(contractId);
  }, [contractId, load]);

  const connectWallet = useCallback(async () => {
    const id = contractDraft.trim();
    if (!id) return;
    await AsyncStorage.setItem(MULTISIG_CONTRACT_STORAGE_KEY, id).catch(() => undefined);
    setContractId(id);
  }, [contractDraft]);

  const disconnectWallet = useCallback(async () => {
    await AsyncStorage.removeItem(MULTISIG_CONTRACT_STORAGE_KEY).catch(() => undefined);
    setContractId(null);
    setDetails(null);
    setProposals([]);
    setLoadError(null);
  }, []);

  const handlePropose = useCallback(async () => {
    if (!contractId) return;
    setProposeError(null);
    setNotice(null);
    setProposing(true);
    try {
      await proposeTransfer({ contractId, proposerSecret: signerSecret, to, amountXlm: amount });
      setTo('');
      setAmount('');
      setNotice('Proposal raised. It needs approvals before it executes.');
      await load(contractId);
    } catch (error) {
      setProposeError(describe(error));
    } finally {
      setProposing(false);
    }
  }, [amount, contractId, load, signerSecret, to]);

  const handleApprove = useCallback(
    async (proposal: Proposal) => {
      if (!contractId || !details) return;
      setApproveErrors((prev) => ({ ...prev, [proposal.id]: '' }));
      setNotice(null);
      setApprovingId(proposal.id);

      const decisive = willExecuteOnApproval(proposal, details.threshold);
      try {
        await approveProposal({ contractId, proposalId: proposal.id, signerSecret });
        setNotice(
          decisive
            ? `Proposal #${proposal.id} reached its threshold and the transfer was executed.`
            : `Approved proposal #${proposal.id}.`
        );
        await load(contractId);
      } catch (error) {
        setApproveErrors((prev) => ({ ...prev, [proposal.id]: describe(error) }));
      } finally {
        setApprovingId(null);
      }
    },
    [contractId, details, load, signerSecret]
  );

  if (!loaded) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  // ── No wallet connected yet ──────────────────────────────────────────────────
  if (!contractId) {
    return (
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>Multisig</Text>
        <Text style={styles.subtitle}>
          Connect a deployed M-of-N wallet to propose transfers and collect approvals from its
          owners.
        </Text>

        <Text style={styles.label}>Multisig contract address</Text>
        <TextInput
          style={[styles.input, styles.mono]}
          placeholder="C…"
          placeholderTextColor={colors.textFaint}
          value={contractDraft}
          onChangeText={setContractDraft}
          autoCapitalize="characters"
          autoCorrect={false}
        />
        <Pressable
          accessibilityRole="button"
          disabled={!contractDraft.trim()}
          onPress={connectWallet}
          style={[styles.primaryButton, !contractDraft.trim() && styles.disabled]}
        >
          <Text style={styles.primaryButtonLabel}>Connect wallet</Text>
        </Pressable>
      </ScrollView>
    );
  }

  const canPropose =
    !proposing &&
    signerAddress !== null &&
    to.trim().length > 0 &&
    amount.trim().length > 0 &&
    (details === null || details.owners.includes(signerAddress));

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void load(contractId)}
          tintColor={colors.accent}
        />
      }
    >
      <Text style={styles.title}>Multisig</Text>
      <Text style={[styles.mono, styles.contractId]}>{contractId}</Text>

      {loadError && <Text style={styles.error}>{loadError}</Text>}

      {details && (
        <View style={styles.card}>
          <View style={styles.statRow}>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>BALANCE</Text>
              <Text style={styles.statValue}>{formatStroopsAsXlm(details.balance)} XLM</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>THRESHOLD</Text>
              <Text style={styles.statValue}>
                {details.threshold} of {details.owners.length}
              </Text>
            </View>
          </View>

          <Text style={styles.statLabel}>OWNERS</Text>
          {details.owners.map((owner) => (
            <Text key={owner} style={[styles.mono, styles.owner]}>
              {truncate(owner)}
              {owner === signerAddress ? '  (you)' : ''}
            </Text>
          ))}
        </View>
      )}

      {/* ── Signing key ──────────────────────────────────────────────────────── */}
      <Text style={styles.sectionTitle}>Signing as</Text>
      <TextInput
        style={[styles.input, styles.mono]}
        placeholder="Owner secret key (S…)"
        placeholderTextColor={colors.textFaint}
        value={signerSecret}
        onChangeText={setSignerSecret}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />
      {signerAddress ? (
        <Text style={styles.hint}>
          {truncate(signerAddress)}
          {details && !details.owners.includes(signerAddress)
            ? ' — not an owner of this wallet'
            : ''}
        </Text>
      ) : (
        signerSecret.length > 0 && <Text style={styles.error}>That is not a valid secret key.</Text>
      )}

      {/* ── Propose ──────────────────────────────────────────────────────────── */}
      <Text style={styles.sectionTitle}>Propose a transfer</Text>
      <TextInput
        style={[styles.input, styles.mono]}
        placeholder="Destination (G… or C…)"
        placeholderTextColor={colors.textFaint}
        value={to}
        onChangeText={setTo}
        autoCapitalize="characters"
        autoCorrect={false}
      />
      <TextInput
        style={styles.input}
        placeholder="Amount in XLM"
        placeholderTextColor={colors.textFaint}
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
      />
      {proposeError && <Text style={styles.error}>{proposeError}</Text>}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Raise proposal"
        disabled={!canPropose}
        onPress={handlePropose}
        style={[styles.primaryButton, !canPropose && styles.disabled]}
      >
        {proposing ? (
          <ActivityIndicator color={colors.onAccent} />
        ) : (
          <Text style={styles.primaryButtonLabel}>Raise proposal</Text>
        )}
      </Pressable>

      {notice && <Text style={styles.notice}>{notice}</Text>}

      {/* ── Queue ────────────────────────────────────────────────────────────── */}
      <Text style={styles.sectionTitle}>Proposals</Text>

      {refreshing && proposals.length === 0 && <ActivityIndicator color={colors.accent} />}

      {!refreshing && proposals.length === 0 && !loadError && (
        <Text style={styles.hint}>No proposals yet. Raise one above.</Text>
      )}

      {details &&
        proposals.map((proposal) => {
          const status = proposalStatus(proposal, details.threshold);
          const blocker = approvalBlocker(proposal, details, signerAddress);
          const decisive = willExecuteOnApproval(proposal, details.threshold);
          const remaining = remainingApprovals(proposal, details.threshold);
          const busy = approvingId === proposal.id;

          return (
            <View
              key={proposal.id}
              style={[styles.card, status === 'executed' && styles.cardExecuted]}
            >
              <View style={styles.proposalHeader}>
                <Text style={styles.proposalId}>Proposal #{proposal.id}</Text>
                <Text
                  style={[
                    styles.status,
                    status === 'executed' && styles.statusExecuted,
                    status === 'ready' && styles.statusReady,
                  ]}
                >
                  {STATUS_LABEL[status]}
                </Text>
              </View>

              <Text style={styles.statLabel}>TO</Text>
              <Text style={[styles.mono, styles.owner]}>{truncate(proposal.to)}</Text>

              <Text style={styles.statLabel}>AMOUNT</Text>
              <Text style={styles.statValue}>{formatStroopsAsXlm(proposal.amount)} XLM</Text>

              <Text style={styles.statLabel}>
                APPROVALS ({proposal.approvals.length}/{details.threshold})
              </Text>
              {proposal.approvals.length === 0 ? (
                <Text style={styles.hint}>None yet.</Text>
              ) : (
                proposal.approvals.map((approver) => (
                  <Text key={approver} style={[styles.mono, styles.owner]}>
                    ✓ {truncate(approver)}
                  </Text>
                ))
              )}

              {status !== 'executed' && (
                <>
                  {decisive && !blocker && (
                    <Text style={styles.decisive}>
                      Yours is the last approval needed — approving sends{' '}
                      {formatStroopsAsXlm(proposal.amount)} XLM immediately.
                    </Text>
                  )}
                  {!decisive && !blocker && (
                    <Text style={styles.hint}>
                      {remaining} more {remaining === 1 ? 'approval' : 'approvals'} needed after
                      yours.
                    </Text>
                  )}
                  {blocker && <Text style={styles.hint}>{blocker}</Text>}
                  {approveErrors[proposal.id] ? (
                    <Text style={styles.error}>{approveErrors[proposal.id]}</Text>
                  ) : null}

                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      decisive
                        ? `Approve and execute proposal ${proposal.id}`
                        : `Approve proposal ${proposal.id}`
                    }
                    disabled={blocker !== null || approvingId !== null}
                    onPress={() => handleApprove(proposal)}
                    style={[
                      styles.primaryButton,
                      (blocker !== null || approvingId !== null) && styles.disabled,
                    ]}
                  >
                    {busy ? (
                      <ActivityIndicator color={colors.onAccent} />
                    ) : (
                      <Text style={styles.primaryButtonLabel}>
                        {decisive ? 'Approve and execute' : 'Approve'}
                      </Text>
                    )}
                  </Pressable>
                </>
              )}
            </View>
          );
        })}

      <Pressable
        accessibilityRole="button"
        onPress={disconnectWallet}
        style={[styles.ghostButton, styles.disconnect]}
      >
        <Text style={styles.ghostButtonLabel}>Use a different multisig wallet</Text>
      </Pressable>
    </ScrollView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: {
      backgroundColor: colors.background,
      flex: 1,
    },
    centered: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    content: {
      gap: 10,
      padding: 24,
      paddingBottom: 64,
    },
    title: {
      color: colors.textStrong,
      fontSize: 28,
      fontWeight: '700',
    },
    subtitle: {
      color: colors.textSecondary,
      fontSize: 14,
      lineHeight: 21,
    },
    contractId: {
      color: colors.accentText,
      fontSize: 12,
      marginBottom: 6,
    },
    sectionTitle: {
      color: colors.textStrong,
      fontSize: 17,
      fontWeight: '600',
      marginTop: 20,
    },
    label: {
      color: colors.textMuted,
      fontSize: 13,
      fontWeight: '600',
      marginTop: 8,
    },
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: 1,
      gap: 4,
      marginTop: 8,
      padding: 16,
    },
    cardExecuted: {
      opacity: 0.75,
    },
    statRow: {
      flexDirection: 'row',
      gap: 24,
      marginBottom: 8,
    },
    stat: {
      gap: 2,
    },
    statLabel: {
      color: colors.textFaint,
      fontSize: 11,
      letterSpacing: 0.8,
      marginTop: 8,
    },
    statValue: {
      color: colors.textPrimary,
      fontSize: 17,
      fontWeight: '600',
    },
    owner: {
      color: colors.textMuted,
      fontSize: 12,
    },
    proposalHeader: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    proposalId: {
      color: colors.textPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
    status: {
      color: colors.textMuted,
      fontSize: 12,
      fontWeight: '600',
    },
    statusReady: {
      color: colors.accentText,
    },
    statusExecuted: {
      color: colors.textFaint,
    },
    decisive: {
      color: colors.accentText,
      fontSize: 13,
      lineHeight: 19,
      marginTop: 10,
    },
    input: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 10,
      borderWidth: 1,
      color: colors.textPrimary,
      fontSize: 15,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    mono: {
      fontFamily: 'Inconsolata_400Regular',
    },
    hint: {
      color: colors.textMuted,
      fontSize: 12,
      lineHeight: 18,
    },
    notice: {
      color: colors.accentText,
      fontSize: 13,
      lineHeight: 19,
    },
    error: {
      color: colors.danger,
      fontSize: 13,
      lineHeight: 19,
    },
    primaryButton: {
      alignItems: 'center',
      backgroundColor: colors.accent,
      borderRadius: 12,
      justifyContent: 'center',
      marginTop: 10,
      minHeight: 48,
      paddingHorizontal: 20,
    },
    primaryButtonLabel: {
      color: colors.onAccent,
      fontSize: 15,
      fontWeight: '600',
    },
    ghostButton: {
      alignItems: 'center',
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: 1,
      justifyContent: 'center',
      minHeight: 48,
      paddingHorizontal: 20,
    },
    ghostButtonLabel: {
      color: colors.textMuted,
      fontSize: 14,
    },
    disconnect: {
      marginTop: 28,
    },
    disabled: {
      opacity: 0.5,
    },
  });
