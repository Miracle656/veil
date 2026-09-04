import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useMemo } from 'react';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';

export type ConfirmModalProps = {
  isOpen: boolean;
  title: string;
  message: string;
  /** Label for the confirming action. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Label for the dismissing action. Defaults to "Cancel". */
  cancelLabel?: string;
  /**
   * Styles the confirm button as destructive. Use it where the action moves
   * real value or is awkward to undo — not merely where it is important.
   */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * A themed confirmation sheet, replacing `Alert.alert` for in-app decisions.
 *
 * `Alert.alert` renders the platform dialog: system fonts, system colours,
 * Android's Material look on one device and iOS's on another. Inside a wallet
 * that is a jarring break — the user is mid-flow in Veil's dark, gold-accented
 * UI and a grey OS box appears — and it cannot show anything the platform does
 * not offer, so warnings all flatten into the same undifferentiated body text.
 *
 * This keeps confirmation inside the app's own visual language, and lets a
 * destructive action actually look destructive.
 */
export function ConfirmModal({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <Modal
      visible={isOpen}
      transparent
      animationType="fade"
      // Android's hardware back should dismiss, matching what a system dialog
      // would do — losing that is the usual regression when replacing Alert.
      onRequestClose={onCancel}
    >
      <Pressable style={styles.backdrop} onPress={onCancel} accessibilityLabel="Dismiss">
        {/* Swallow taps on the card so pressing the sheet itself never dismisses. */}
        <Pressable style={styles.card} onPress={() => {}}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.message}>{message}</Text>

          <View style={styles.actions}>
            <Pressable
              testID="confirm-modal-cancel"
              accessibilityRole="button"
              onPress={onCancel}
              style={({ pressed }) => [styles.button, styles.cancel, pressed && styles.pressed]}
            >
              <Text style={styles.cancelText}>{cancelLabel}</Text>
            </Pressable>

            <Pressable
              testID="confirm-modal-confirm"
              accessibilityRole="button"
              onPress={onConfirm}
              style={({ pressed }) => [
                styles.button,
                destructive ? styles.destructive : styles.confirm,
                pressed && styles.pressed,
              ]}
            >
              <Text style={destructive ? styles.destructiveText : styles.confirmText}>
                {confirmLabel}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.6)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    card: {
      width: '100%',
      maxWidth: 380,
      borderRadius: 20,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      padding: 20,
    },
    title: {
      color: colors.textPrimary,
      fontSize: 18,
      fontWeight: '700',
      marginBottom: 8,
    },
    message: {
      color: colors.textMuted,
      fontSize: 14,
      lineHeight: 20,
    },
    actions: {
      flexDirection: 'row',
      gap: 10,
      marginTop: 20,
    },
    button: {
      flex: 1,
      borderRadius: 999,
      paddingVertical: 13,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cancel: {
      backgroundColor: 'transparent',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    cancelText: {
      color: colors.textPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
    confirm: {
      backgroundColor: colors.accent,
    },
    confirmText: {
      color: colors.onAccent,
      fontSize: 15,
      fontWeight: '700',
    },
    destructive: {
      backgroundColor: colors.danger,
    },
    destructiveText: {
      color: '#FFFFFF',
      fontSize: 15,
      fontWeight: '700',
    },
    pressed: {
      opacity: 0.85,
    },
  });
}
