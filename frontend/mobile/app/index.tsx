import { useEffect, useRef, useState } from "react";
import { View, ActivityIndicator, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";

const WALLET_KEY = "invisible_wallet_address";
const SEEN_WELCOME_KEY = "veil_seen_welcome";

async function readWallet(
  retries = 1,
): Promise<{ wallet: string | null; seenWelcome: string | null }> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const [wallet, seenWelcome] = await Promise.all([
        AsyncStorage.getItem(WALLET_KEY),
        AsyncStorage.getItem(SEEN_WELCOME_KEY),
      ]);
      return { wallet, seenWelcome };
    } catch {
      if (attempt === retries) throw;
    }
  }
  throw new Error("unreachable");
}

export default function Index() {
  const router = useRouter();
  const navigated = useRef(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const { wallet, seenWelcome } = await readWallet();
        if (navigated.current) return;
        navigated.current = true;

        if (wallet) {
          router.replace("/dashboard");
        } else if (seenWelcome) {
          router.replace("/create-wallet");
        } else {
          router.replace("/welcome");
        }
      } catch {
        if (navigated.current) return;
        navigated.current = true;
        router.replace("/welcome");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#D4A843" />
      </View>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0B0B0F",
  },
});
