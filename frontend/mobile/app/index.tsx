import { Link } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import { colors } from "../lib/theme";

export default function Home() {
  return (
    <View style={styles.container} testID="home-screen">
      <Text style={styles.title}>Veil Mobile</Text>
      <Text style={styles.subtitle}>Placeholder home route — toolchain is live.</Text>

      <View style={styles.nav}>
        <Link href="/create-wallet" testID="home-create-wallet-link" style={styles.link}>
          Create wallet
        </Link>
        <Link href="/send" testID="home-send-link" style={styles.link}>
          Send
        </Link>
        <Link href="/receive" testID="home-receive-link" style={styles.link}>
          Receive
        </Link>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.background,
    padding: 24,
  },
  title: {
    color: colors.text,
    fontSize: 28,
    fontWeight: "700",
  },
  subtitle: {
    color: colors.muted,
    fontSize: 15,
    marginTop: 8,
    textAlign: "center",
  },
  nav: {
    marginTop: 32,
    gap: 16,
    alignItems: "center",
  },
  link: {
    color: colors.accent,
    fontSize: 17,
    fontWeight: "600",
  },
});
