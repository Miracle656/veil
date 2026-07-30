import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { useRouter } from 'expo-router';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';

/**
 * Lock screen — the native port of the web wallet's `app/lock/page.tsx`.
 *
 * The wallet reaches here after an inactivity timeout or on returning from the
 * background (see `hooks/useInactivityLock.ts`). Unlocking requires a real
 * device biometric via `expo-local-authentication`
 * (`authenticateAsync` prompts Face ID / fingerprint, falling back to the device
 * passcode); on success we return to the dashboard.
 */
export default function LockScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();

  const [isUnlocking, setIsUnlocking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUnlock = useCallback(async () => {
    setError(null);
    setIsUnlocking(true);
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();
      if (!hasHardware || !isEnrolled) {
        setError('No biometric or device passcode is set up. Add one in system settings.');
        return;
      }

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock Veil',
        cancelLabel: 'Cancel',
        // Allow the device passcode when biometrics fail, matching OS behaviour.
        disableDeviceFallback: false,
      });

      if (result.success) {
        router.replace('/');
        return;
      }
      setError('Unlock failed. Please try again.');
    } catch {
      setError('Unlock failed. Please try again.');
    } finally {
      setIsUnlocking(false);
    }
  }, [router]);

  // Prompt immediately on arrival so the user isn't stranded on a dead screen.
  useEffect(() => {
    void handleUnlock();
  }, [handleUnlock]);

  return (
    <View style={styles.container}>
      <View style={styles.iconCircle}>
        <Text style={styles.iconGlyph}>🔒</Text>
      </View>

      <View style={styles.copy}>
        <Text style={styles.title}>Wallet locked</Text>
        <Text style={styles.subtitle}>Unlock with your biometric to continue.</Text>
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable
        accessibilityRole="button"
        onPress={handleUnlock}
        disabled={isUnlocking}
        style={({ pressed }) => [styles.button, (pressed || isUnlocking) && styles.buttonPressed]}
      >
        {isUnlocking ? (
          <ActivityIndicator color={colors.onAccent} />
        ) : (
          <Text style={styles.buttonLabel}>Unlock</Text>
        )}
      </Pressable>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.background,
      padding: 32,
      gap: 28,
    },
    iconCircle: {
      width: 72,
      height: 72,
      borderRadius: 36,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    iconGlyph: {
      fontSize: 30,
    },
    copy: {
      alignItems: 'center',
      gap: 6,
    },
    title: {
      color: colors.textStrong,
      fontSize: 22,
      fontWeight: '700',
    },
    subtitle: {
      color: colors.textSecondary,
      fontSize: 15,
      textAlign: 'center',
    },
    error: {
      color: colors.danger,
      fontSize: 14,
      textAlign: 'center',
    },
    button: {
      alignSelf: 'stretch',
      maxWidth: 320,
      backgroundColor: colors.accent,
      borderRadius: 999,
      paddingVertical: 14,
      alignItems: 'center',
    },
    buttonPressed: {
      opacity: 0.75,
    },
    buttonLabel: {
      color: colors.onAccent,
      fontSize: 16,
      fontWeight: '700',
    },
  });
