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
import { createPasskeyWallet } from '../lib/passkeyWallet';
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
              <Text style={[styles.fund, { color: colors.danger }]}>
                Heads up: this device couldn&apos;t bind the recovery secret to your passkey, so this
                wallet can&apos;t be restored on another phone from the passkey alone. Keep this device
                safe or set up recovery servers in Settings.
              </Text>
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
