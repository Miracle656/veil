import type { ReactNode } from "react";
import { StyleSheet, Text, View, type TextStyle } from "react-native";

import { colors } from "../../theme/colors";

type HighlightProps = {
  children: ReactNode;
  textStyle?: TextStyle;
};

/**
 * Gold highlighter underlay — the native equivalent of the web wallet's `.hl`
 * (globals.css), which paints a translucent gold gradient across the lower
 * portion of the text. RN can't gradient-fill inline text, so we approximate
 * the highlighter with a flat translucent gold band behind the bottom ~40%,
 * which reads the same at a glance.
 */
export function Highlight({ children, textStyle }: HighlightProps) {
  return (
    <View style={styles.wrap}>
      <View style={styles.band} pointerEvents="none" />
      <Text style={[styles.text, textStyle]}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignSelf: "flex-start",
  },
  band: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: "42%",
    backgroundColor: "rgba(253,218,36,0.42)",
    borderRadius: 2,
  },
  text: {
    color: colors.offWhite,
    paddingBottom: 2,
  },
});
