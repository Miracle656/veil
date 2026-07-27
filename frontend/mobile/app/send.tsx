import { StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const GOLD = "#FDDA24";
const NEAR_BLACK = "#0F0F0F";
const OFF_WHITE = "#F6F7F8";

/**
 * Placeholder send screen: shows whatever a SEP-7 pay link pre-filled.
 * The interactive recipient/amount form and passkey submit flow are built
 * in follow-up issues (backlog #36, #37) — this only proves the deep link
 * lands here with the right fields.
 */
export default function Send() {
  const insets = useSafeAreaInsets();
  const { destination, amount, assetCode, assetIssuer, memo } =
    useLocalSearchParams<{
      destination?: string;
      amount?: string;
      assetCode?: string;
      assetIssuer?: string;
      memo?: string;
    }>();

  return (
    <View style={[styles.shell, { paddingTop: insets.top + 24 }]}>
      <Text style={styles.title}>Send</Text>

      {destination ? (
        <View style={styles.field}>
          <Text style={styles.label}>To</Text>
          <Text style={styles.value}>{destination}</Text>
        </View>
      ) : null}

      {amount ? (
        <View style={styles.field}>
          <Text style={styles.label}>Amount</Text>
          <Text style={styles.value}>
            {amount} {assetCode ?? "XLM"}
          </Text>
        </View>
      ) : null}

      {assetIssuer ? (
        <View style={styles.field}>
          <Text style={styles.label}>Asset issuer</Text>
          <Text style={styles.value}>{assetIssuer}</Text>
        </View>
      ) : null}

      {memo ? (
        <View style={styles.field}>
          <Text style={styles.label}>Memo</Text>
          <Text style={styles.value}>{memo}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    backgroundColor: NEAR_BLACK,
    paddingHorizontal: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    color: GOLD,
    marginBottom: 24,
  },
  field: {
    marginBottom: 16,
  },
  label: {
    fontSize: 13,
    color: "rgba(246,247,248,0.5)",
    marginBottom: 4,
  },
  value: {
    fontSize: 16,
    color: OFF_WHITE,
  },
});
