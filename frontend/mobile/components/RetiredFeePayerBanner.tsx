import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { useTheme } from '../hooks/useTheme';
import {
  claimRetiredFeePayer,
  findRetiredFeePayerWithBalance,
  type RetiredFeePayerCandidate,
} from '../lib/retiredFeePayerCleanup';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';

/**
 * One-time cleanup banner for users who moved off a random-key spending
 * account on an earlier build and still have XLM locked on the old account.
 */
export function RetiredFeePayerBanner({ onClaimed }: { onClaimed?: () => void }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [candidate, setCandidate] = useState<RetiredFeePayerCandidate | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (dismissed) return;
      let cancelled = false;
      void (async () => {
        try {
          const found = await findRetiredFeePayerWithBalance();
          if (!cancelled) setCandidate(found);
        } catch {
          // Best-effort check; never block the dashboard.
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [dismissed]),
  );

  if (!candidate || dismissed) return null;

  async function handleClaim() {
    if (!candidate || claiming) return;
    setClaiming(true);
    setError(null);
    const outcome = await claimRetiredFeePayer(candidate);
    setClaiming(false);
    if (outcome.claimed) {
      setCandidate(null);
      onClaimed?.();
    } else {
      setError('Could not bring the leftover XLM across right now. Try again later.');
    }
  }

  return (
    <View style={styles.card} testID="retired-fee-payer-banner">
      <View style={styles.headerRow}>
        <Text style={styles.title}>Leftover XLM on old fee account</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss leftover XLM notice"
          onPress={() => setDismissed(true)}
          hitSlop={8}
          style={({ pressed }) => [styles.dismiss, pressed && styles.pressed]}
        >
          <Text style={styles.dismissText}>✕</Text>
        </Pressable>
      </View>
      <Text style={styles.body}>
        An old spending account still holds {candidate.xlm.toFixed(2)} XLM in reserve from an
        earlier move. Bring it across and close the old account.
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable
        accessibilityRole="button"
        testID="retired-fee-payer-claim"
        onPress={handleClaim}
        disabled={claiming}
        style={({ pressed }) => [styles.primary, (pressed || claiming) && styles.pressed]}
      >
        {claiming ? (
          <ActivityIndicator size="small" color={colors.onAccent} />
        ) : (
          <Text style={styles.primaryLabel}>Bring XLM across</Text>
        )}
      </Pressable>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    card: {
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      backgroundColor: colors.surface,
      padding: 16,
      gap: 10,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    title: {
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 14,
      color: colors.textStrong,
      flexShrink: 1,
    },
    dismiss: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceMd,
    },
    dismissText: {
      color: colors.textSecondary,
      fontSize: 13,
      fontWeight: '700',
    },
    body: {
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 20,
      color: colors.textPrimary,
    },
    error: {
      fontFamily: fontFamily.body,
      fontSize: 12,
      color: colors.danger,
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
    pressed: { opacity: 0.7 },
  });
