import type { ReactNode } from "react";
import { useMemo } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";

import { useTheme } from "../../hooks/useTheme";
import type { ThemeColors } from "../../lib/theme";

type CardProps = {
  children: ReactNode;
  /** `default` → `.card`, `md` → `.card-md` (raised surface). */
  variant?: "default" | "md";
  style?: ViewStyle;
};

/**
 * Surface container — the native equivalent of the web wallet's `.card` /
 * `.card-md` (globals.css): a rounded, bordered panel over a translucent
 * surface. `md` uses the raised surface + slightly brighter border. Themed.
 */
export function Card({ children, variant = "default", style }: CardProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={[styles.base, variant === "md" ? styles.md : styles.default, style]}>
      {children}
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    base: {
      borderRadius: 16,
      borderWidth: 1,
      padding: 24,
    },
    default: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
    },
    md: {
      backgroundColor: colors.surfaceMd,
      borderColor: colors.border,
    },
  });
