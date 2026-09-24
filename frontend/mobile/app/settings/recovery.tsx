import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
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

export default function RecoverySettingsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [prf, setPrf] = useState<PrfRecoveryState>('unverified');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      setPrf(await checkPasskeyRecovery());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not check this passkey.');
    } finally {
      setChecking(false);
    }
  };
  return (
    <ScrollView
      style={[styles.screen, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
    >
      <Text style={styles.title}>Recovery coverage</Text>
      <Text style={styles.summary}>{status?.summary ?? 'Checking wallet recovery…'}</Text>
      <Text style={styles.body}>
        Coverage is derived from this device and your configured recovery services. One mechanism is
        helpful; it is not the same as having all three.
      </Text>
      {status?.mechanisms.map((mechanism) => (
        <View key={mechanism.key} style={styles.card}>
          <View style={styles.copy}>
            <Text style={styles.label}>{mechanism.label}</Text>
            <Text style={styles.detail}>
              {mechanism.ready
                ? 'Ready'
                : mechanism.needsCheck
                  ? 'Not checked yet'
                  : 'Not configured'}
            </Text>
          </View>
          {mechanism.key === 'prf' && !mechanism.ready ? (
            <Pressable onPress={checkPrf} disabled={checking} style={styles.button}>
              {checking ? (
                <ActivityIndicator color={colors.onAccent} />
              ) : (
                <Text style={styles.buttonText}>{mechanism.action}</Text>
              )}
            </Pressable>
          ) : !mechanism.ready ? (
            <Pressable
              onPress={() =>
                router.push(mechanism.key === 'backup' ? '/settings/backup' : '/recover')
              }
              style={styles.button}
            >
              <Text style={styles.buttonText}>{mechanism.action}</Text>
            </Pressable>
          ) : (
            <Text style={styles.ready}>✓</Text>
          )}
        </View>
      ))}
      {error && <Text style={styles.error}>{error}</Text>}
    </ScrollView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1 },
    content: { gap: 12, padding: 24, paddingBottom: 48 },
    title: { color: colors.textStrong, fontSize: 28, fontWeight: '700' },
    summary: { color: colors.accentText, fontSize: 18, fontWeight: '700', marginTop: 8 },
    body: { color: colors.textSecondary, fontSize: 14, lineHeight: 21, marginBottom: 8 },
    card: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 14,
      borderWidth: 1,
      flexDirection: 'row',
      gap: 12,
      padding: 16,
    },
    copy: { flex: 1, gap: 5 },
    label: { color: colors.textPrimary, fontSize: 16, fontWeight: '600' },
    detail: { color: colors.textMuted, fontSize: 13 },
    ready: { color: colors.accentText, fontSize: 20, fontWeight: '700' },
    button: {
      backgroundColor: colors.accent,
      borderRadius: 9,
      paddingHorizontal: 12,
      paddingVertical: 9,
    },
    buttonText: { color: colors.onAccent, fontSize: 12, fontWeight: '700' },
    error: { color: colors.danger, fontSize: 13 },
  });
