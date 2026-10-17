/**
 * Recovery coverage — which of the three ways back into this wallet are ready.
 *
 * Branded like the rest of settings: a back chevron and a Lora title through
 * FlowHeader, and theme colours rather than the raw weights this screen used to
 * draw itself with. It had no header at all, so it was reachable and then not
 * leavable except by the system gesture.
 *
 * The passkey check also says more than it used to. `retryRecoveryBinding`
 * returns `failed` both for a genuine one-off error and for a wallet whose
 * credential id this device cannot see, and the screen rendered both as "Could
 * not check this passkey. Try again." — advice that, in the second case, could
 * never work no matter how many times it was followed. A check that fails twice
 * now stops telling the user to repeat it and points at the backup instead.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { FlowHeader } from '../../components/FlowHeader';
import { useTheme } from '../../hooks/useTheme';
import { getLastBackupExportedAt } from '../../lib/backupFile';
import {
  deriveRecoveryStatus,
  type PrfRecoveryState,
  type RecoveryStatus,
} from '../../lib/recoveryStatus';
import { checkPasskeyRecovery } from '../../lib/recoveryStatusActions';
import { listRecoveryServerUrls } from '../../lib/recovery';
import { getSignerSecret, getWalletAddress } from '../../lib/walletStore';
import type { ThemeColors } from '../../lib/theme';
import { fontFamily } from '../../theme/typography';

export default function RecoverySettingsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [prf, setPrf] = useState<PrfRecoveryState>('unverified');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * How many times the passkey check has come back unsuccessful. One failure is
   * worth retrying; a second means retrying is not the answer, and saying so is
   * the difference between a hint and a loop.
   */
  const [failedChecks, setFailedChecks] = useState(0);

  const refresh = useCallback(async () => {
    const [walletAddress, signerSecret, backupLastExportedAt, servers] = await Promise.all([
      getWalletAddress(),
      getSignerSecret(),
      getLastBackupExportedAt(),
      listRecoveryServerUrls(),
    ]);
    setStatus(
      deriveRecoveryStatus({
        walletAddress,
        signerSecret,
        prf,
        backupLastExportedAt,
        recoveryServerCount: servers.length,
      })
    );
  }, [prf]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const checkPrf = async () => {
    setChecking(true);
    setError(null);
    try {
      const outcome = await checkPasskeyRecovery();
      setPrf(outcome);
      setFailedChecks((n) => (outcome === 'ready' ? 0 : n + 1));
    } catch (cause) {
      setFailedChecks((n) => n + 1);
      setError(cause instanceof Error ? cause.message : 'Could not check this passkey.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <FlowHeader title="Recovery coverage" />
      </View>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <Text style={styles.summary}>{status?.summary ?? 'Checking wallet recovery…'}</Text>
        <Text style={styles.body}>
          Coverage is derived from this device and your configured recovery services. One mechanism
          is helpful; it is not the same as having all three.
        </Text>

        {status?.mechanisms.map((mechanism) => (
          <View key={mechanism.key} style={styles.card}>
            <View style={styles.copy}>
              <Text style={styles.label}>{mechanism.label}</Text>
              <Text style={styles.detail}>
                {mechanism.detail ?? (mechanism.ready ? 'Ready' : 'Not configured')}
              </Text>
            </View>
            {mechanism.key === 'prf' && mechanism.needsCheck ? (
              <Pressable
                onPress={() => void checkPrf()}
                disabled={checking}
                accessibilityRole="button"
                style={({ pressed }) => [styles.button, pressed && styles.pressed]}
              >
                {checking ? (
                  <ActivityIndicator color={colors.onAccent} />
                ) : (
                  <Text style={styles.buttonText}>{mechanism.action}</Text>
                )}
              </Pressable>
            ) : !mechanism.ready ? (
              <Pressable
                onPress={() =>
                  router.push(mechanism.key === 'servers' ? '/recover' : '/settings/backup')
                }
                accessibilityRole="button"
                style={({ pressed }) => [styles.button, pressed && styles.pressed]}
              >
                <Text style={styles.buttonText}>{mechanism.action}</Text>
              </Pressable>
            ) : (
              <Text style={styles.ready}>✓</Text>
            )}
          </View>
        ))}

        {failedChecks >= 2 && (
          <View style={styles.noticeCard}>
            <Text style={styles.noticeTitle}>Checking again won&apos;t help</Text>
            <Text style={styles.body}>
              This passkey isn&apos;t giving us a recovery secret, and asking it again gets the same
              answer. An encrypted backup covers the same ground and does not depend on it.
            </Text>
            <Pressable
              onPress={() => router.push('/settings/backup')}
              accessibilityRole="button"
              style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
            >
              <Text style={styles.secondaryText}>Create a backup instead</Text>
            </Pressable>
          </View>
        )}

        {error && <Text style={styles.error}>{error}</Text>}
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    header: { paddingHorizontal: 20, paddingTop: 16 },
    content: { gap: 12, padding: 20, paddingBottom: 48 },
    summary: {
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 18,
      color: colors.accentText,
      marginTop: 4,
    },
    body: {
      fontFamily: fontFamily.body,
      fontSize: 14,
      lineHeight: 21,
      color: colors.textSecondary,
    },
    card: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: 12,
      padding: 18,
    },
    copy: { flex: 1, gap: 5 },
    label: { fontFamily: fontFamily.bodySemiBold, fontSize: 16, color: colors.textStrong },
    detail: { fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19, color: colors.textMuted },
    ready: { fontFamily: fontFamily.bodySemiBold, fontSize: 20, color: colors.accentText },
    button: {
      backgroundColor: colors.accent,
      borderRadius: 100,
      paddingHorizontal: 16,
      paddingVertical: 11,
      minHeight: 40,
      justifyContent: 'center',
    },
    buttonText: { fontFamily: fontFamily.bodySemiBold, fontSize: 13, color: colors.onAccent },
    noticeCard: {
      backgroundColor: colors.surface,
      borderColor: colors.accent,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      gap: 10,
      padding: 18,
    },
    noticeTitle: { fontFamily: fontFamily.bodySemiBold, fontSize: 16, color: colors.textStrong },
    secondary: {
      alignItems: 'center',
      paddingVertical: 11,
      borderRadius: 100,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    secondaryText: { fontFamily: fontFamily.bodyMedium, fontSize: 14, color: colors.textPrimary },
    pressed: { opacity: 0.7 },
    error: { fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19, color: colors.danger },
  });
