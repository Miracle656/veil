import type { ReactNode } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";

import { colors } from "../../theme/colors";

type CardProps = {
  children: ReactNode;
  /** `default` → `.card`, `md` → `.card-md` (raised surface). */
  variant?: "default" | "md";
  style?: ViewStyle;
};

/**
 * Surface container — the native equivalent of the web wallet's `.card` /
 * `.card-md` (globals.css): a rounded, bordered panel over a translucent
 * surface. `md` uses the raised surface + slightly brighter border.
 */
export function Card({ children, variant = "default", style }: CardProps) {
  return (
    <View style={[styles.base, variant === "md" ? styles.md : styles.default, style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 24,
  },
  default: {
    backgroundColor: colors.surface,
    borderColor: colors.borderDim,
  },
  md: {
    backgroundColor: colors.surfaceMd,
    borderColor: "rgba(255,255,255,0.10)",
  },
});
