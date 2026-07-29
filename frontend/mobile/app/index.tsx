import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

import { ThemeToggle } from "../components/ThemeToggle";
import { useTheme } from "../hooks/useTheme";
import type { ThemeColors } from "../lib/theme";

export default function Home() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={styles.container}>
      <ThemeToggle style={styles.toggle} />
      <Text style={styles.title}>Veil Mobile</Text>
      <Text style={styles.subtitle}>Placeholder home route — toolchain is live.</Text>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.background,
      padding: 24,
    },
    toggle: {
      position: "absolute",
      top: 64,
      right: 24,
    },
    title: {
      color: colors.textStrong,
      fontSize: 28,
      fontWeight: "700",
    },
    subtitle: {
      color: colors.textSecondary,
      fontSize: 15,
      marginTop: 8,
      textAlign: "center",
    },
  });
