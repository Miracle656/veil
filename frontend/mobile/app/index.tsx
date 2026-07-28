import { useState } from "react";
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import ActivityFeed from "../components/ActivityFeed";
import { useInitActivityFeed } from "../lib/activityFeed";

const WRAITH_URL =
  process.env.EXPO_PUBLIC_WRAITH_URL?.replace(/\/+$/, "") ?? null;

const DEMO_ADDRESS =
  process.env.EXPO_PUBLIC_DEMO_ADDRESS ?? null;

export default function Home() {
  const [txFilter, setTxFilter] = useState<"all" | "transfers" | "swaps">(
    "all",
  );

  const { loading } = useInitActivityFeed(DEMO_ADDRESS, WRAITH_URL);

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.logo}>VEIL</Text>
          <Text style={styles.heading}>Dashboard</Text>
          <Text style={styles.subtitle}>
            Recent transfers render live from the Wraith indexer.
          </Text>
        </View>

        {/* Filter pills */}
        <View style={styles.filterRow}>
          {(["all", "transfers", "swaps"] as const).map((f) => (
            <Text
              key={f}
              style={[
                styles.filterPill,
                txFilter === f && styles.filterPillActive,
              ]}
              onPress={() => setTxFilter(f)}
            >
              {f === "all" ? "All" : f === "transfers" ? "Transfers" : "Swaps"}
            </Text>
          ))}
        </View>

        {/* Activity feed */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>ACTIVITY</Text>
          <ActivityFeed filter={txFilter} loading={loading} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#0B0B0F",
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: 20,
    paddingTop: 60,
  },
  header: {
    marginBottom: 24,
  },
  logo: {
    fontFamily: "monospace",
    fontSize: 13,
    letterSpacing: 2,
    color: "#FDDA24",
    marginBottom: 8,
  },
  heading: {
    fontSize: 28,
    fontWeight: "700",
    color: "#F6F7F8",
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: "#9BA1A6",
    lineHeight: 20,
  },
  filterRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 16,
  },
  filterPill: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 100,
    fontSize: 12,
    fontWeight: "500",
    color: "rgba(246,247,248,0.5)",
    borderWidth: 1,
    borderColor: "rgba(246,247,248,0.15)",
    overflow: "hidden",
  },
  filterPillActive: {
    backgroundColor: "#FDDA24",
    borderColor: "#FDDA24",
    color: "#0E0E12",
    fontWeight: "600",
  },
  section: {
    marginBottom: 24,
  },
  sectionLabel: {
    fontSize: 11,
    fontFamily: "monospace",
    letterSpacing: 2,
    color: "#9BA1A6",
    marginBottom: 12,
  },
});
