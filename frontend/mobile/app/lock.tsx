import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as LocalAuthentication from 'expo-local-authentication';
import { useRouter } from 'expo-router';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { VeilLogo } from '../components/VeilLogo';

/**
 * Lock screen — brand treatment of the web wallet's lock page: the Drape mark
 * over near-black, Lora title, gold unlock action. Reached after an inactivity
 * timeout or a long background stay (hooks/useInactivityLock.ts). Unlocking
 * prompts the device biometric (passcode fallback) and returns to the
 * dashboard directly, skipping the splash.
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
        disableDeviceFallback: false,
      });

      if (result.success) {
        // Straight to the dashboard — routing through the splash re-runs the
        // whole entry sequence and reads as a second loading screen.
        router.replace('/dashboard');
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
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="lock-screen">
      <View style={styles.center}>
        <VeilLogo size={72} color={colors.accent} />
        <Text style={styles.wordmark}>VEIL</Text>
        <Text style={styles.title}>Wallet locked</Text>
        <Text style={styles.subtitle}>Unlock with your fingerprint or Face ID to continue.</Text>
        {error && <Text style={styles.error}>{error}</Text>}
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={handleUnlock}
        disabled={isUnlocking}
        style={({ pressed }) => [styles.cta, (pressed || isUnlocking) && styles.ctaPressed]}
      >
        {isUnlocking ? (
          <ActivityIndicator color={colors.onAccent} />
        ) : (
          <Text style={styles.ctaText}>Unlock</Text>
        )}
      </Pressable>
    </SafeAreaView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: colors.background,
      paddingHorizontal: 28,
      paddingBottom: 28,
    },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    wordmark: {
      fontFamily: fontFamily.accent,
      fontSize: 22,
      letterSpacing: 2.2,
      color: colors.accent,
      marginTop: 18,
    },
    title: {
      color: colors.textStrong,
      fontFamily: fontFamily.heading,
      fontSize: 28,
      marginTop: 22,
    },
    subtitle: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 14,
      lineHeight: 21,
      textAlign: 'center',
      maxWidth: 280,
      marginTop: 4,
    },
    error: {
      color: colors.danger,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
      textAlign: 'center',
      marginTop: 14,
      maxWidth: 300,
    },
    cta: {
      backgroundColor: colors.accent,
      borderRadius: 100,
      paddingVertical: 17,
      alignItems: 'center',
    },
    ctaPressed: {
      opacity: 0.85,
    },
    ctaText: {
      color: colors.onAccent,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
    },
  });
