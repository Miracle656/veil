import { useState, useEffect } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
} from "react-native";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";

const SEEN_WELCOME_KEY = "veil_seen_welcome";

export default function Welcome() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      const seen = await AsyncStorage.getItem(SEEN_WELCOME_KEY);
      if (seen) {
        router.replace("/dashboard");
        return;
      }
      setReady(true);
    })();
  }, []);

  const handleGetStarted = async () => {
    await AsyncStorage.setItem(SEEN_WELCOME_KEY, "1");
    router.push("/create-wallet");
  };

  const handleRecover = async () => {
    await AsyncStorage.setItem(SEEN_WELCOME_KEY, "1");
    router.push("/recover");
  };

  if (!ready) return null;

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      bounces={false}
    >
      {/* Logo */}
      <View style={styles.logoContainer}>
        <View style={styles.logoRing}>
          <Text style={styles.logoLetter}>V</Text>
        </View>
      </View>

      {/* Title */}
      <Text style={styles.title}>VEIL</Text>
      <Text style={styles.tagline}>Your passkey is your wallet</Text>

      {/* Feature highlights */}
      <View style={styles.features}>
        <View style={styles.featureRow}>
          <Text style={styles.featureIcon}>🔐</Text>
          <View style={styles.featureText}>
            <Text style={styles.featureTitle}>No seed phrases</Text>
            <Text style={styles.featureDesc}>
              Your biometric passkey is the only key. No private keys to lose, no
              words to write down.
            </Text>
          </View>
        </View>

        <View style={styles.featureRow}>
          <Text style={styles.featureIcon}>⚡</Text>
          <View style={styles.featureText}>
            <Text style={styles.featureTitle}>Instant setup</Text>
            <Text style={styles.featureDesc}>
              Create a self-custody wallet in seconds with just your fingerprint
              or face.
            </Text>
          </View>
        </View>

        <View style={styles.featureRow}>
          <Text style={styles.featureIcon}>🌐</Text>
          <View style={styles.featureText}>
            <Text style={styles.featureTitle}>Stellar network</Text>
            <Text style={styles.featureDesc}>
              Fast, low-cost payments on Soroban smart contracts. Your keys, your
              coins.
            </Text>
          </View>
        </View>
      </View>

      {/* Actions */}
      <View style={styles.actions}>
        <Pressable
          style={({ pressed }) => [styles.btnPrimary, pressed && styles.btnPressed]}
          onPress={handleGetStarted}
        >
          <Text style={styles.btnPrimaryText}>Get started</Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [styles.btnSecondary, pressed && styles.btnPressed]}
          onPress={handleRecover}
        >
          <Text style={styles.btnSecondaryText}>Recover existing wallet</Text>
        </Pressable>
      </View>

      {/* Footer */}
      <Text style={styles.footer}>
        Powered by{" "}
        <Text style={styles.footerHighlight}>Stellar Soroban</Text>
      </Text>
    </ScrollView>
  );
}

const GOLD = "#D4A843";

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0B0B0F",
  },
  content: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingVertical: 48,
    minHeight: "100%",
  },
  logoContainer: {
    marginBottom: 24,
  },
  logoRing: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 2,
    borderColor: GOLD,
    alignItems: "center",
    justifyContent: "center",
  },
  logoLetter: {
    fontSize: 36,
    fontWeight: "700",
    color: GOLD,
    fontFamily: "System",
  },
  title: {
    fontSize: 32,
    fontWeight: "800",
    letterSpacing: 4,
    color: GOLD,
    marginBottom: 8,
  },
  tagline: {
    fontSize: 15,
    color: "rgba(246,247,248,0.5)",
    marginBottom: 48,
  },
  features: {
    width: "100%",
    gap: 24,
    marginBottom: 48,
  },
  featureRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 14,
  },
  featureIcon: {
    fontSize: 24,
    marginTop: 2,
  },
  featureText: {
    flex: 1,
  },
  featureTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#F6F7F8",
    marginBottom: 4,
  },
  featureDesc: {
    fontSize: 14,
    color: "rgba(246,247,248,0.5)",
    lineHeight: 20,
  },
  actions: {
    width: "100%",
    gap: 12,
  },
  btnPrimary: {
    backgroundColor: GOLD,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: "center",
  },
  btnPrimaryText: {
    color: "#0B0B0F",
    fontSize: 16,
    fontWeight: "700",
  },
  btnSecondary: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: "rgba(246,247,248,0.15)",
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: "center",
  },
  btnSecondaryText: {
    color: "#F6F7F8",
    fontSize: 16,
    fontWeight: "600",
  },
  btnPressed: {
    opacity: 0.7,
  },
  footer: {
    marginTop: 32,
    fontSize: 12,
    color: "#7C7C7C",
    textAlign: "center",
  },
  footerHighlight: {
    color: "rgba(246,247,248,0.88)",
  },
});
