import { errorMessage } from '../lib/errorMessage';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Constants, { ExecutionEnvironment } from 'expo-constants';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { FlowHeader } from '../components/FlowHeader';
import { createTestnetWallet, importTestnetWallet, type CreatedWallet } from '../lib/testnetWallet';
import {
  createPasskeyWallet,
  recreatePasskeyWallet,
  retryRecoveryBinding,
  type RecoveryRetry,
} from '../lib/passkeyWallet';
import { getNetwork } from '../lib/network';
import { useWallet } from '../components/WalletProvider';

// Passkeys need the native module — unavailable in Expo Go.
const IN_EXPO_GO = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

type Status = 'idle' | 'busy' | 'created' | 'error';

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-6)}` : a;
}

/**
 * Testnet wallet onboarding. Generates a Stellar keypair, funds it with
 * Friendbot, and stores it as the active wallet — a real, signable account so
 * every flow (send / receive / swap / earn) works on testnet. Also supports
 * importing an existing secret seed.
 */
export default function CreateWallet() {
  const router = useRouter();
  const { colors } = useTheme();
  const { wallet } = useWallet();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<CreatedWallet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [secret, setSecret] = useState('');
  const [binding, setBinding] = useState(false);
  const [recreating, setRecreating] = useState(false);
  const [bindIssue, setBindIssue] = useState<Extract<RecoveryRetry, { bound: false }>['issue'] | null>(null);

  const recoveryIssue = bindIssue ?? result?.recoveryIssue ?? 'failed';
  const busyRepairing = binding || recreating;

  /**
   * Swap this wallet for one built on a fresh passkey. The old address is
   * abandoned, which only holds up while it is still empty — it is empty here
   * because the user has not left the creation screen yet.
   */
  async function recreate() {
    setRecreating(true);
    setError(null);
    try {
      const again = await recreatePasskeyWallet(wallet);
      if (!again.ok) {
        setBindIssue('funded');
        return;
      }
      setResult(again.wallet);
      setBindIssue(again.wallet.recoverable === false ? (again.wallet.recoveryIssue ?? 'failed') : null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRecreating(false);
    }
  }

  async function retryBinding() {
    setBinding(true);
    try {
      const retry = await retryRecoveryBinding();
      if (retry.bound) {
        setResult((prev) => (prev ? { ...prev, recoverable: true, recoveryIssue: undefined } : prev));
        setBindIssue(null);
      } else {
        setBindIssue(retry.issue);
      }
    } finally {
      setBinding(false);
    }
  }

  async function run(fn: () => Promise<CreatedWallet>) {
    setStatus('busy');
    setError(null);
    try {
      setResult(await fn());
      setStatus('created');
    } catch (e) {
      setError(errorMessage(e));
      setStatus('error');
    }
  }

  if (status === 'created' && result) {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
        <View style={styles.body}>
          <FlowHeader title="Wallet ready" />
          <View style={styles.doneCard}>
            <Text style={styles.doneTitle}>You&apos;re all set</Text>
            <Text style={styles.label}>Address</Text>
            <Text testID="create-wallet-address" style={styles.addr}>{shortAddr(result.address)}</Text>
            <Text style={[styles.fund, { color: result.funded ? colors.positive : colors.textMuted }]}>
              {result.funded
                ? 'Funded with test XLM ✓'
                : getNetwork().friendbotUrl
                  ? 'Friendbot was busy — you can still receive funds and retry later'
                  : 'Send XLM to your wallet to activate it — mainnet has no faucet'}
            </Text>
            {result.recoverable === false && (
              <>
                <Text style={[styles.fund, { color: colors.danger }]}>{recoveryMessage(recoveryIssue)}</Text>
                {/*
                  Which repair to offer depends on why it failed. Asking the same
                  manager again is pointless once it has answered without PRF, and
                  a manager that has none will never grow one — that case needs a
                  different passkey, not another attempt.
                */}
                {recoveryIssue === 'unsupported' ? (
                  <Pressable
                    testID="create-wallet-recreate"
                    accessibilityRole="button"
                    disabled={busyRepairing}
                    onPress={recreate}
                    style={({ pressed }) => [styles.ctaSecondary, busyRepairing && styles.disabled, pressed && styles.pressed]}
                  >
                    {recreating ? (
                      <ActivityIndicator color={colors.textPrimary} />
                    ) : (
                      <Text style={styles.ctaSecondaryText}>Use a different passkey</Text>
                    )}
                  </Pressable>
                ) : recoveryIssue !== 'funded' ? (
                  <Pressable
                    testID="create-wallet-retry-recovery"
                    accessibilityRole="button"
                    disabled={busyRepairing}
                    onPress={retryBinding}
                    style={({ pressed }) => [styles.ctaSecondary, busyRepairing && styles.disabled, pressed && styles.pressed]}
                  >
                    {binding ? (
                      <ActivityIndicator color={colors.textPrimary} />
                    ) : (
                      <Text style={styles.ctaSecondaryText}>Try setting up recovery again</Text>
                    )}
                  </Pressable>
                ) : null}
                {/*
                  Always reachable, and on a manager without PRF it is the way
                  out that cannot fail: the backup carries the wallet's address
                  and passkey public key, which is what a fresh device needs to
                  find this wallet again and rebind a signer to it.
                */}
                <Pressable
                  testID="create-wallet-save-backup"
                  accessibilityRole="button"
                  disabled={busyRepairing}
                  onPress={() => router.push('/settings/backup')}
                  style={styles.linkBtn}
                >
                  <Text style={styles.link}>Save a recovery file instead</Text>
                </Pressable>
                {error && <Text style={[styles.fund, { color: colors.danger }]}>{error}</Text>}
              </>
            )}
            {result.recoverable === true && result.recoveryIssue === undefined && bindIssue === null && binding === false && (
              <Text style={[styles.fund, { color: colors.positive }]}>Recovery is bound to your passkey ✓</Text>
            )}
          </View>
          <View style={styles.spacer} />
          <Pressable
            testID="create-wallet-continue-button"
            accessibilityRole="button"
            onPress={() => router.replace('/dashboard')}
            style={({ pressed }) => [styles.cta, pressed && styles.pressed]}
          >
            <Text style={styles.ctaText}>Continue</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="create-wallet-screen">
      <View style={styles.body}>
        <FlowHeader title="Create wallet" />
        <Text style={styles.caption}>
          {IN_EXPO_GO
            ? "Spin up a testnet wallet to try Veil end-to-end. It's a real Stellar account, funded with test XLM — no seed phrase to write down."
            : getNetwork().friendbotUrl
              ? 'Create a passkey smart wallet (a C-address secured by your Face ID / fingerprint, with a PRF-derived fee-payer), or use a plain testnet keypair. Both fund automatically.'
              : 'Create a passkey smart wallet secured by your Face ID / fingerprint. This is MAINNET — fund it afterwards by sending real XLM to your wallet.'}
        </Text>

        {importing ? (
          <>
            <Text style={styles.section}>Secret key</Text>
            <View style={styles.card}>
              <TextInput
                style={styles.input}
                value={secret}
                onChangeText={setSecret}
                placeholder="S… (56 characters)"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="characters"
                autoCorrect={false}
              />
            </View>
            <Pressable
              accessibilityRole="button"
              disabled={status === 'busy' || secret.trim().length < 56}
              onPress={() => run(() => importTestnetWallet(secret))}
              style={({ pressed }) => [styles.cta, (status === 'busy' || secret.trim().length < 56) && styles.disabled, pressed && styles.pressed]}
            >
              {status === 'busy' ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.ctaText}>Import wallet</Text>}
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setImporting(false)} style={styles.linkBtn}>
              <Text style={styles.link}>Create a new one instead</Text>
            </Pressable>
          </>
        ) : (
          <>
            <View style={styles.spacer} />
            {!IN_EXPO_GO && (
              <Pressable
                testID="create-passkey-button"
                accessibilityRole="button"
                disabled={status === 'busy'}
                onPress={() => run(() => createPasskeyWallet(wallet))}
                style={({ pressed }) => [styles.cta, status === 'busy' && styles.disabled, pressed && styles.pressed]}
              >
                {status === 'busy' ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.ctaText}>Create with passkey</Text>}
              </Pressable>
            )}
            <Pressable
              testID="create-wallet-button"
              accessibilityRole="button"
              disabled={status === 'busy'}
              onPress={() => run(createTestnetWallet)}
              style={({ pressed }) => [
                IN_EXPO_GO ? styles.cta : styles.ctaSecondary,
                status === 'busy' && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              {status === 'busy' && IN_EXPO_GO ? (
                <ActivityIndicator color={colors.onAccent} />
              ) : (
                <Text style={IN_EXPO_GO ? styles.ctaText : styles.ctaSecondaryText}>
                  {IN_EXPO_GO
                    ? 'Create testnet wallet'
                    : getNetwork().friendbotUrl
                      ? 'Use a testnet keypair instead'
                      : 'Use a classic keypair instead'}
                </Text>
              )}
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setImporting(true)} style={styles.linkBtn}>
              <Text style={styles.link}>I already have a secret key</Text>
            </Pressable>
          </>
        )}

        {status === 'error' && error && <Text style={styles.errorText}>{error}</Text>}
      </View>
    </SafeAreaView>
  );
}

/**
 * What went wrong with the recovery secret, in terms of what to do about it.
 * The old single warning could not tell a manager that will never support
 * recovery from a prompt that was simply closed.
 *
 * None of these send the user into device settings. Being told to go and delete
 * a credential by hand before the wallet is usable is how testers on phones
 * whose stock password manager has no PRF got stuck, and every case here has a
 * repair that lives on this screen instead.
 */
function recoveryMessage(issue: 'unsupported' | 'cancelled' | 'failed' | 'funded'): string {
  switch (issue) {
    case 'unsupported':
      return "Your passkey was saved in a password manager that can't hold a recovery secret, so on a new phone the passkey alone would not be enough to find this wallet. Use a different passkey, or save a recovery file — either one fixes it. Do it before adding money.";
    case 'cancelled':
      return "Recovery isn't set up yet: the second passkey prompt was closed before it finished. Try again and approve it.";
    case 'funded':
      return "Recovery can't be bound to this wallet any more, because its spending account is already on chain and replacing that key would strand what it holds. Save a recovery file so this wallet can be found from another phone, or set up recovery servers in Settings.";
    default:
      return "Recovery couldn't be set up on this attempt, so this wallet can't yet be restored on another phone from the passkey alone. Try again before adding money.";
  }
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    body: { flex: 1, paddingHorizontal: 24, paddingTop: 16, paddingBottom: 28 },
    caption: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 14,
      lineHeight: 21,
      marginTop: 18,
    },
    section: {
      color: colors.textFaint,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 11,
      letterSpacing: 1.4,
      textTransform: 'uppercase',
      marginTop: 28,
      marginBottom: 8,
    },
    card: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 16,
      paddingHorizontal: 16,
      paddingVertical: 13,
    },
    input: { color: colors.textPrimary, fontFamily: fontFamily.address, fontSize: 14, padding: 0 },
    spacer: { flex: 1 },
    cta: {
      backgroundColor: colors.accent,
      borderRadius: 100,
      paddingVertical: 17,
      alignItems: 'center',
      marginTop: 18,
    },
    disabled: { opacity: 0.4 },
    ctaText: { color: colors.onAccent, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },
    ctaSecondary: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 100,
      paddingVertical: 16,
      alignItems: 'center',
      marginTop: 12,
    },
    ctaSecondaryText: { color: colors.textPrimary, fontFamily: fontFamily.bodyMedium, fontSize: 14 },
    linkBtn: { alignItems: 'center', paddingVertical: 14 },
    link: { color: colors.accent, fontFamily: fontFamily.bodyMedium, fontSize: 14 },
    errorText: { color: colors.danger, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 18, marginTop: 14, textAlign: 'center' },

    doneCard: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 20,
      padding: 22,
      marginTop: 28,
      gap: 6,
    },
    doneTitle: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 22, marginBottom: 6 },
    label: { color: colors.textFaint, fontFamily: fontFamily.bodySemiBold, fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase', marginTop: 4 },
    addr: { color: colors.textPrimary, fontFamily: fontFamily.address, fontSize: 15 },
    fund: { fontFamily: fontFamily.bodyMedium, fontSize: 13, marginTop: 8 },
    pressed: { opacity: 0.7 },
  });
