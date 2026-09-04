import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { BackIcon } from './icons';

/**
 * A flow screen's header — a back chevron and a Lora-italic title, matching the
 * redesign's Send / Receive / Swap / Airtime screens. Back defaults to
 * `router.back()`; pass `onBack` to override.
 */
export function FlowHeader({ title, onBack }: { title: string; onBack?: () => void }) {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={styles.row}>
      <Pressable
        onPress={onBack ?? (() => router.back())}
        accessibilityRole="button"
        accessibilityLabel="Back"
        hitSlop={10}
        style={({ pressed }) => [styles.back, pressed && styles.pressed]}
      >
        <BackIcon size={22} color={colors.textSecondary} />
      </Pressable>
      <Text style={styles.title}>{title}</Text>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
    },
    back: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceMd,
      borderWidth: 1,
      borderColor: colors.border,
    },
    pressed: {
      opacity: 0.6,
    },
    title: {
      color: colors.textStrong,
      fontFamily: fontFamily.heading,
      fontSize: 26,
    },
  });
