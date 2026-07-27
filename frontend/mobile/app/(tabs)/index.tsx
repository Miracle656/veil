import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const GOLD = "#FDDA24";
const NEAR_BLACK = "#0F0F0F";
const OFF_WHITE = "#F6F7F8";
const BORDER_DIM = "rgba(255,255,255,0.08)";

export default function Dashboard() {
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.shell}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.wordmark}>VEIL</Text>
      </View>

      <ScrollView
        style={styles.main}
        contentContainerStyle={styles.mainContent}
        contentInsetAdjustmentBehavior="automatic"
      >
        <Text style={styles.title}>Dashboard</Text>
        <Text style={styles.subtitle}>
          Your wallet locks automatically after 5 minutes of inactivity.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    backgroundColor: NEAR_BLACK,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER_DIM,
  },
  wordmark: {
    fontSize: 20,
    fontWeight: "800",
    letterSpacing: 3,
    color: GOLD,
  },
  main: {
    flex: 1,
  },
  mainContent: {
    padding: 20,
    paddingTop: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: "600",
    fontStyle: "italic",
    color: OFF_WHITE,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: "rgba(246,247,248,0.5)",
  },
});
