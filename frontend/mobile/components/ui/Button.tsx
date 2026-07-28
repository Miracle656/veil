import { Pressable, StyleSheet, Text, type ViewStyle } from "react-native";

import { colors } from "../../theme/colors";
import { fontFamily } from "../../theme/typography";

type ButtonProps = {
  label: string;
  onPress?: () => void;
  /** `gold` → `.btn-gold` (filled), `ghost` → `.btn-ghost` (outline). */
  variant?: "gold" | "ghost";
  disabled?: boolean;
  /** Fill the container width, like the web buttons (`width: 100%`). */
  fullWidth?: boolean;
  style?: ViewStyle;
};

/**
 * Pill CTA button — the native equivalent of the web wallet's `.btn-gold` /
 * `.btn-ghost` (globals.css). Gold is the filled primary action; ghost is the
 * bordered secondary. Press scales to 0.98; disabled drops to 0.4 opacity.
 */
export function Button({
  label,
  onPress,
  variant = "gold",
  disabled = false,
  fullWidth = true,
  style,
}: ButtonProps) {
  const isGold = variant === "gold";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        isGold ? styles.gold : styles.ghost,
        fullWidth && styles.fullWidth,
        pressed && !disabled && styles.pressed,
        disabled && styles.disabled,
        style,
      ]}
    >
      <Text style={[styles.label, isGold ? styles.labelGold : styles.labelGhost]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 100,
  },
  fullWidth: {
    alignSelf: "stretch",
  },
  gold: {
    backgroundColor: colors.goldFill,
  },
  ghost: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: colors.borderDim,
  },
  pressed: {
    transform: [{ scale: 0.98 }],
  },
  disabled: {
    opacity: 0.4,
  },
  label: {
    fontSize: 15,
  },
  labelGold: {
    color: colors.nearBlack,
    fontFamily: fontFamily.bodySemiBold,
  },
  labelGhost: {
    color: colors.offWhite,
    fontFamily: fontFamily.bodyMedium,
  },
});
