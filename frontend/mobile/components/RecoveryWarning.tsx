/**
 * RecoveryWarning — the #711 pre-action notice.
 *
 * Rendered by the privacy screens when the wallet's spend key is not
 * re-derivable from a passkey on another device (keypair-mode wallet, random
 * fallback, or a PRF-less passkey such as Samsung Pass). Nothing can be
 * confirmed while it is on screen: the user must explicitly acknowledge that
 * private balances moved in with this key are recoverable only on this
 * device, or leave and set up a PRF-capable passkey first.
 */

import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { PRIVACY_RECOVERY_WARNING } from '../lib/privacy/keys';
import { ShieldIcon } from './icons';

export function RecoveryWarning({ onAcknowledge }: { onAcknowledge: () => void }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={styles.card} testID="privacy-recovery-warning">
      <View style={styles.titleRow}>
        <ShieldIcon size={16} color={colors.danger} />
        <Text style={styles.title}>Not recoverable on another device</Text>
      </View>
      <Text style={styles.body}>{PRIVACY_RECOVERY_WARNING}</Text>
      <Text style={styles.strong}>
        Only continue if you understand that losing this device means losing any private balance
        created with this key.
      </Text>
      <Pressable
        onPress={onAcknowledge}
        accessibilityRole="button"
        testID="privacy-recovery-acknowledge"
        style={({ pressed }) => [styles.ackBtn, pressed && styles.pressed]}
      >
        <Text style={styles.ackText}>I understand — allow on this device only</Text>
      </Pressable>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    card: {
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.danger,
      backgroundColor: 'rgba(255,92,92,0.06)',
      padding: 16,
      gap: 10,
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    title: {
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 14,
      color: colors.danger,
      flexShrink: 1,
    },
    body: {
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 20,
      color: colors.textSecondary,
    },
    strong: {
      fontFamily: fontFamily.bodyMedium,
      fontSize: 13,
      lineHeight: 20,
      color: colors.textPrimary,
    },
    ackBtn: {
      borderRadius: 100,
      borderWidth: 1,
      borderColor: colors.border,
      paddingVertical: 12,
      alignItems: 'center',
    },
    ackText: {
      fontFamily: fontFamily.bodyMedium,
      fontSize: 13,
      color: colors.textPrimary,
    },
    pressed: { opacity: 0.7 },
  });
