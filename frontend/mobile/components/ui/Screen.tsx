import type { ReactNode } from "react";
import { useMemo } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";

import { useTheme } from "../../hooks/useTheme";
import type { ThemeColors } from "../../lib/theme";

type ScreenProps = {
  children: ReactNode;
  /** Which safe-area edges to inset. Defaults to top + bottom. */
  edges?: readonly Edge[];
  /** Apply the standard horizontal gutter. Defaults to true. */
  padded?: boolean;
  style?: ViewStyle;
};

/**
 * Full-height themed shell — the native equivalent of the web wallet's
 * `.wallet-shell` (globals.css): a `min-height: 100dvh` flex column on the
 * app background, here combined with safe-area insets. Follows light/dark.
 */
export function Screen({ children, edges = ["top", "bottom"], padded = true, style }: ScreenProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <SafeAreaView style={styles.shell} edges={edges}>
      <View style={[styles.body, padded && styles.padded, style]}>{children}</View>
    </SafeAreaView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    shell: {
      flex: 1,
      backgroundColor: colors.background,
    },
    body: {
      flex: 1,
    },
    padded: {
      paddingHorizontal: 20,
    },
  });
