import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useTheme } from "../hooks/useTheme";
import type { ThemeColors } from "../lib/theme";

/**
 * Placeholder wallet creation screen. The real passkey registration and
 * factory deploy land with the SDK wiring; this route exists so onboarding
 * links (`veil://create-wallet`) and the home screen have a destination.
 */
export default function CreateWallet() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [status, setStatus] = useState<"idle" | "creating" | "created">("idle");

  const handleCreate = () => {
    setStatus("creating");
    // Stands in for passkey registration + on-chain deploy.
    setTimeout(() => setStatus("created"), 400);
  };

  return (
    <View style={styles.container} testID="create-wallet-screen">
      <Text style={styles.title}>Create your wallet</Text>
      <Text style={styles.caption}>
        Your device biometrics guard the wallet. No seed phrase to write down.
      </Text>

      {status === "created" ? (
        <>
          <Text testID="create-wallet-success" style={styles.success}>
            Wallet created
          </Text>
          <Pressable
            testID="create-wallet-continue-button"
            accessibilityRole="button"
            onPress={() => router.replace("/")}
            style={styles.button}
          >
            <Text style={styles.buttonText}>Continue</Text>
          </Pressable>
        </>
      ) : (
        <Pressable
          testID="create-wallet-button"
          accessibilityRole="button"
          onPress={handleCreate}
          disabled={status === "creating"}
          style={[styles.button, status === "creating" && styles.buttonDisabled]}
        >
          <Text style={styles.buttonText}>
            {status === "creating" ? "Waiting for biometric…" : "Create wallet"}
          </Text>
        </Pressable>
      )}
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
      gap: 16,
      padding: 24,
    },
    title: {
      color: colors.textStrong,
      fontSize: 24,
      fontWeight: "700",
    },
    caption: {
      color: colors.textSecondary,
      fontSize: 14,
      textAlign: "center",
    },
    success: {
      color: colors.textStrong,
      fontSize: 18,
      fontWeight: "600",
    },
    button: {
      backgroundColor: colors.accent,
      borderRadius: 12,
      marginTop: 8,
      paddingHorizontal: 28,
      paddingVertical: 14,
    },
    buttonDisabled: {
      opacity: 0.6,
    },
    buttonText: {
      color: colors.onAccent,
      fontSize: 16,
      fontWeight: "600",
    },
  });
