/**
 * Security settings — the mobile port of the web wallet's
 * `app/settings/security/page.tsx`, extended with the biometric requirement.
 *
 * Two controls, both feeding the lock system (backlog #28) through
 * `lib/appLock.ts`: how long the app may sit idle before locking, and whether
 * the unlock has to present a biometric factor. Selections apply immediately —
 * a running idle watcher reschedules off the new timeout the moment it is
 * chosen, rather than at the next lock.
 */

import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { useAppLock } from '../../hooks/useAppLock';
import { useTheme } from '../../hooks/useTheme';
import { LOCK_TIMEOUT_OPTIONS, type LockTimeout } from '../../lib/appLock';
import type { ThemeColors } from '../../lib/theme';

function optionLabel(option: LockTimeout): string {
  return option === 'never' ? 'Never' : `${option} minutes`;
}

const OPTION_DESCRIPTION: Record<string, string> = {
  '5': 'Most secure',
  '15': 'Recommended',
  '30': 'Relaxed',
  never: 'Not recommended — auto-lock disabled',
};

export default function SecuritySettingsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { timeout, requireBiometrics, selectTimeout, selectRequireBiometrics } = useAppLock();

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Security</Text>

      <Text style={styles.sectionLabel}>AUTO-LOCK</Text>
      <Text style={styles.sectionBody}>
        Lock the app and require your passkey again after a period of inactivity. Switching to
        another app does not reset the timer — the countdown keeps running while Veil is in the
        background.
      </Text>

      <View style={styles.options}>
        {LOCK_TIMEOUT_OPTIONS.map((option) => {
          const selected = option === timeout;
          return (
            <Pressable
              key={String(option)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={`Lock after ${optionLabel(option)}`}
              onPress={() => selectTimeout(option)}
              style={[styles.option, selected && styles.optionSelected]}
            >
              <View style={styles.optionCopy}>
                <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]}>
                  {optionLabel(option)}
                </Text>
                <Text style={styles.optionDescription}>{OPTION_DESCRIPTION[String(option)]}</Text>
              </View>
              {selected && <Text style={styles.optionCheck}>✓</Text>}
            </Pressable>
          );
        })}
      </View>

      {timeout === 'never' && (
        <Text style={styles.warning}>
          With auto-lock off, anyone who picks up this device can use your wallet without
          re-verifying. Only choose this on a device you fully trust.
        </Text>
      )}

      <Text style={styles.sectionLabel}>UNLOCKING</Text>
      <Text style={styles.sectionBody}>
        Require Face ID, Touch ID, or your device biometric to unlock. If biometrics are
        unavailable when you return, the app falls back to your passkey rather than locking you
        out of your funds.
      </Text>

      <View style={styles.switchRow}>
        <View style={styles.switchCopy}>
          <Text style={styles.switchLabel}>Require biometric unlock</Text>
          <Text style={styles.switchDescription}>
            {requireBiometrics
              ? 'A biometric check is requested every time the app unlocks.'
              : 'Your passkey alone can unlock the app.'}
          </Text>
        </View>
        <Switch
          accessibilityLabel="Require biometric unlock"
          value={requireBiometrics}
          onValueChange={selectRequireBiometrics}
          thumbColor={colors.onAccent}
          trackColor={{ false: colors.border, true: colors.accent }}
        />
      </View>
    </ScrollView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: {
      backgroundColor: colors.background,
      flex: 1,
    },
    content: {
      gap: 8,
      padding: 24,
      paddingBottom: 48,
    },
    title: {
      color: colors.textStrong,
      fontSize: 28,
      fontWeight: '700',
      marginBottom: 8,
    },
    sectionLabel: {
      color: colors.textFaint,
      fontSize: 12,
      letterSpacing: 1,
      marginTop: 20,
    },
    sectionBody: {
      color: colors.textSecondary,
      fontSize: 13,
      lineHeight: 20,
    },
    options: {
      gap: 10,
      marginTop: 8,
    },
    option: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: 1,
      flexDirection: 'row',
      gap: 12,
      padding: 16,
    },
    optionSelected: {
      borderColor: colors.accent,
    },
    optionCopy: {
      flex: 1,
      gap: 4,
    },
    optionLabel: {
      color: colors.textPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
    optionLabelSelected: {
      color: colors.accentText,
    },
    optionDescription: {
      color: colors.textMuted,
      fontSize: 13,
    },
    optionCheck: {
      color: colors.accentText,
      fontSize: 16,
      fontWeight: '700',
    },
    warning: {
      color: colors.danger,
      fontSize: 12,
      lineHeight: 18,
      marginTop: 10,
    },
    switchRow: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: 1,
      flexDirection: 'row',
      gap: 16,
      marginTop: 8,
      padding: 16,
    },
    switchCopy: {
      flex: 1,
      gap: 4,
    },
    switchLabel: {
      color: colors.textPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
    switchDescription: {
      color: colors.textMuted,
      fontSize: 13,
      lineHeight: 18,
    },
  });
