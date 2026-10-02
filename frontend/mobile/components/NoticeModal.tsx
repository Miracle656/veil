import { useMemo } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';

/**
 * A one-button themed notice — the counterpart to ConfirmModal for messages
 * that report rather than ask.
 *
 * ConfirmModal always renders two buttons, so using it for "here is what
 * happened" invents a choice that does not exist. The alternative was
 * `Alert.alert`, which drops the platform dialog into the middle of Veil's own
 * UI: system fonts, system colours, and no way to distinguish a success from a
 * failure beyond the words themselves.
 */
export function NoticeModal({
  isOpen,
  title,
  message,
  actionLabel = 'Got it',
  tone = 'neutral',
  onClose,
}: {
  isOpen: boolean;
  title: string;
  message: string;
  actionLabel?: string;
  /** Colours the title. Use it where the outcome matters, not for emphasis. */
  tone?: 'neutral' | 'success' | 'error';
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const titleColor =
    tone === 'success' ? colors.positive : tone === 'error' ? colors.danger : colors.textStrong;

  return (
    <Modal visible={isOpen} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={[styles.title, { color: titleColor }]}>{title}</Text>
          <Text style={styles.message}>{message}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          >
            <Text style={styles.actionText}>{actionLabel}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.6)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    sheet: {
      width: '100%',
      maxWidth: 380,
      backgroundColor: colors.surfaceMd,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 20,
      gap: 10,
    },
    title: { fontFamily: fontFamily.bodySemiBold, fontSize: 17 },
    message: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 14, lineHeight: 20 },
    action: {
      marginTop: 6,
      paddingVertical: 12,
      borderRadius: 12,
      backgroundColor: colors.accent,
      alignItems: 'center',
    },
    actionText: { color: colors.onAccent, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },
    pressed: { opacity: 0.7 },
  });
