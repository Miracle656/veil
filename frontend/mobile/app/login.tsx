import { errorMessage } from '../lib/errorMessage';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Constants, { ExecutionEnvironment } from 'expo-constants';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { FlowHeader } from '../components/FlowHeader';
import { HexagonIcon } from '../components/icons';
import { loginWithPasskey } from '../lib/passkeyLogin';

const IN_EXPO_GO = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

/**
 * Sign in with an existing wallet. The headline path is the passkey: one
 * fingerprint re-derives the fee-payer (PRF) and reads the on-chain
 * breadcrumbs, restoring the wallet even on a brand-new phone — as long as the
 * passkey itself synced (Google Password Manager / iCloud Keychain). The
 * recovery-server flow and raw-key import remain as fallbacks.
 */
export default function LoginScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePasskeyLogin = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await loginWithPasskey();
      router.replace('/dashboard');
      void result;
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="login-screen">
      <View style={styles.body}>
        <FlowHeader title="Sign in" />
        <Text style={styles.caption}>
          Your passkey is your account. If it&apos;s on this phone — or synced to it — one tap brings your
          wallet back, even on a fresh install.
        </Text>

        <View style={styles.spacer} />

        {error && <Text style={styles.errorText}>{error}</Text>}

        {!IN_EXPO_GO && (
          <Pressable
            testID="login-passkey-button"
            accessibilityRole="button"
            disabled={busy}
            onPress={handlePasskeyLogin}
            style={({ pressed }) => [styles.cta, busy && styles.disabled, pressed && styles.pressed]}
          >
            {busy ? (
              <ActivityIndicator color={colors.onAccent} />
            ) : (
              <>
                <HexagonIcon size={17} color={colors.onAccent} />
                <Text style={styles.ctaText}>Sign in with passkey</Text>
              </>
            )}
          </Pressable>
        )}

        <Pressable accessibilityRole="button" onPress={() => router.push('/recover')} style={styles.linkBtn}>
          <Text style={styles.link}>Lost your passkey? Recover with servers</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => router.push('/create-wallet')} style={styles.linkBtn}>
          <Text style={styles.linkMuted}>Import a testnet secret key instead</Text>
        </Pressable>
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
    spacer: { flex: 1 },
    errorText: {
      color: colors.danger,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
      textAlign: 'center',
      marginBottom: 14,
    },
    cta: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: colors.accent,
      borderRadius: 100,
      paddingVertical: 17,
    },
    disabled: { opacity: 0.5 },
    pressed: { opacity: 0.85 },
    ctaText: { color: colors.onAccent, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },
    linkBtn: { alignItems: 'center', paddingVertical: 13 },
    link: { color: colors.accent, fontFamily: fontFamily.bodyMedium, fontSize: 14 },
    linkMuted: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13 },
  });
