import { useEffect, useState } from "react";
import { View, ActivityIndicator, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";

const WALLET_KEY = "invisible_wallet_address";
const SEEN_WELCOME_KEY = "veil_seen_welcome";

export default function Index() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const wallet = await AsyncStorage.getItem(WALLET_KEY);
        if (wallet) {
          router.replace("/dashboard");
          return;
        }

        const seenWelcome = await AsyncStorage.getItem(SEEN_WELCOME_KEY);
        if (seenWelcome) {
          router.replace("/dashboard");
          return;
        }

        router.replace("/welcome");
      } catch {
        router.replace("/welcome");
      } finally {
        setChecking(false);
      }
    })();
  }, []);

  if (!checking) return null;

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color="#D4A843" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0B0B0F",
  },
});
