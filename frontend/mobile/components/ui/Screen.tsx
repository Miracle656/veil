import type { ReactNode } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";

import { colors } from "../../theme/colors";

type ScreenProps = {
  children: ReactNode;
  /** Which safe-area edges to inset. Defaults to top + bottom. */
  edges?: readonly Edge[];
  /** Apply the standard horizontal gutter. Defaults to true. */
  padded?: boolean;
  style?: ViewStyle;
};

/**
 * Full-height dark shell — the native equivalent of the web wallet's
 * `.wallet-shell` (globals.css): a `min-height: 100dvh` flex column on the
 * near-black background, here combined with safe-area insets.
 */
export function Screen({ children, edges = ["top", "bottom"], padded = true, style }: ScreenProps) {
  return (
    <SafeAreaView style={styles.shell} edges={edges}>
      <View style={[styles.body, padded && styles.padded, style]}>{children}</View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    backgroundColor: colors.nearBlack,
  },
  body: {
    flex: 1,
  },
  padded: {
    paddingHorizontal: 20,
  },
});
