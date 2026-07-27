import { useLocalSearchParams } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import { colors } from "../lib/theme";

/**
 * Placeholder receive screen. QR rendering and the real wallet address land
 * with the SDK wiring; this route exists so `veil://receive` and
 * `https://app.veil.xyz/receive` have somewhere to go.
 */
const PLACEHOLDER_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export default function Receive() {
  const { amount, asset } = useLocalSearchParams<{ amount?: string; asset?: string }>();
  const requested = typeof amount === "string" ? amount : undefined;

  return (
    <View style={styles.container} testID="receive-screen">
      <Text style={styles.title}>Receive</Text>
      <Text style={styles.caption}>Share this address to get paid.</Text>

      <Text testID="receive-address" selectable style={styles.address}>
        {PLACEHOLDER_ADDRESS}
      </Text>

      {requested ? (
        <Text testID="receive-requested-amount" style={styles.caption}>
          Requesting {requested} {typeof asset === "string" && asset ? asset : "XLM"}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.background,
    gap: 16,
    padding: 24,
  },
  title: {
    color: colors.text,
    fontSize: 24,
    fontWeight: "700",
  },
  caption: {
    color: colors.muted,
    fontSize: 14,
    textAlign: "center",
  },
  address: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    fontFamily: "monospace",
    fontSize: 13,
    padding: 14,
    textAlign: "center",
  },
});
