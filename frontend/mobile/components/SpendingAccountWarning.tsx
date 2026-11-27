/**
 * The "this address is not backed up" notice on the dashboard and Receive.
 *
 * The decision is in `lib/spendingAccountWarning.ts`. This reads the wallet,
 * asks it, and draws the answer. It renders nothing when there is nothing to
 * say, so a screen can place it unconditionally.
 *
 * It re-reads on every focus, so it disappears as soon as the user comes back
 * from securing the account, without the screen having to be told.
 */
import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { useTheme } from '../hooks/useTheme';
import { getFeePayerInfo } from '../lib/feePayerSource';
import { spendingAccountWarning, type SpendingAccountWarning as Warning } from '../lib/spendingAccountWarning';
import type { ThemeColors } from '../lib/theme';
import { getWalletAddress } from '../lib/walletStore';
import { fontFamily } from '../theme/typography';
import { ShieldIcon } from './icons';

export function SpendingAccountWarning({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [warning, setWarning] = useState<Warning | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void (async () => {
        try {
          const [wallet, info] = await Promise.all([getWalletAddress(), getFeePayerInfo()]);
          if (!cancelled) setWarning(spendingAccountWarning(wallet, info?.source ?? null));
        } catch {
          // A storage read failing is not evidence the account is safe or
          // unsafe. Keep whatever was last shown.
        }
      })();
      return () => {
        cancelled = true;
      };
    }, []),
  );

  if (!warning) return null;
  const danger = warning.level === 'danger';

  // One tappable line, for a screen with no room for the full card.
  if (compact) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${warning.title}. ${warning.primary}`}
        testID="spending-account-warning"
        onPress={() => router.push('/settings/recovery')}
        style={({ pressed }) => [
          styles.card,
          styles.compact,
          danger ? styles.cardDanger : styles.cardCheck,
          pressed && styles.pressed,
        ]}
      >
        <ShieldIcon size={16} color={danger ? colors.danger : colors.accentText} />
        <Text style={[styles.title, danger && styles.titleDanger]}>{warning.title}. Tap to fix.</Text>
      </Pressable>
    );
  }

  return (
    <View
      style={[styles.card, danger ? styles.cardDanger : styles.cardCheck]}
      testID="spending-account-warning"
      accessibilityRole="alert"
    >
      <View style={styles.titleRow}>
        <ShieldIcon size={16} color={danger ? colors.danger : colors.accentText} />
        <Text style={[styles.title, danger && styles.titleDanger]}>{warning.title}</Text>
      </View>
      <Text style={styles.body}>{warning.body}</Text>
      <Pressable
        accessibilityRole="button"
        testID="spending-account-warning-primary"
        onPress={() => router.push('/settings/recovery')}
        style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
      >
        <Text style={styles.primaryLabel}>{warning.primary}</Text>
      </Pressable>
      {warning.secondary ? (
        <Pressable
          accessibilityRole="button"
          testID="spending-account-warning-secondary"
          onPress={() => router.push('/settings/reveal-secret?subject=spending')}
          style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
        >
          <Text style={styles.secondaryLabel}>{warning.secondary}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    card: {
      borderRadius: 16,
      borderWidth: 1,
      padding: 16,
      gap: 10,
    },
    compact: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 12,
      marginTop: 16,
    },
    cardDanger: {
      borderColor: colors.danger,
      backgroundColor: colors.dangerSurface,
    },
    cardCheck: {
      borderColor: colors.borderStrong,
      backgroundColor: colors.surface,
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    title: {
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 14,
      color: colors.textStrong,
      flexShrink: 1,
    },
    titleDanger: { color: colors.danger },
    body: {
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 20,
      color: colors.textPrimary,
    },
    primary: {
      borderRadius: 100,
      backgroundColor: colors.accent,
      paddingVertical: 12,
      alignItems: 'center',
    },
    primaryLabel: {
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 13,
      color: colors.onAccent,
    },
    secondary: {
      borderRadius: 100,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      paddingVertical: 12,
      alignItems: 'center',
    },
    secondaryLabel: {
      fontFamily: fontFamily.bodyMedium,
      fontSize: 13,
      color: colors.textPrimary,
    },
    pressed: { opacity: 0.7 },
  });
