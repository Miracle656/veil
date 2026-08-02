import { useEffect, useMemo, useRef, useState } from "react";
import { View, ActivityIndicator, StyleSheet, Text } from "react-native";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { useTheme } from "../hooks/useTheme";
import type { ThemeColors } from "../lib/theme";
import { getWalletAddress } from "../lib/walletStore";
import { QuickActions } from "../components/QuickActions";

// Whether the intro has been seen is presentation state, not a secret, so it
// lives in AsyncStorage. The wallet address itself is read through walletStore,
// which keeps it in the Keychain/Keystore — reading it from AsyncStorage here
// would be a second source of truth that never sees a real wallet.
const SEEN_WELCOME_KEY = "veil_seen_welcome";

async function readEntryState(
  retries = 1,
): Promise<{ wallet: string | null; seenWelcome: string | null }> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const [wallet, seenWelcome] = await Promise.all([
        getWalletAddress(),
        AsyncStorage.getItem(SEEN_WELCOME_KEY),
      ]);
      return { wallet, seenWelcome };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

export default function Index() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const navigated = useRef(false);
  const [loading, setLoading] = useState(true);
  const [showDashboard, setShowDashboard] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { wallet, seenWelcome } = await readEntryState();
        if (navigated.current) return;
        navigated.current = true;

        if (wallet) {
          // User has a wallet, show the dashboard instead of redirecting
          setShowDashboard(true);
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
  }, [router]);

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  // Show the Veil Mobile dashboard when user has a wallet
  if (showDashboard) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Veil Mobile</Text>
        <Text style={styles.subtitle}>Dashboard</Text>
        <QuickActions />
      </View>
    );
  }

  // This shouldn't normally render as we redirect, but acts as a fallback
  return null;
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.background,
      padding: 24,
    },
    title: {
      color: colors.textStrong,
      fontSize: 24,
      fontWeight: "700",
    },
    subtitle: {
      color: colors.textSecondary,
      fontSize: 15,
      marginTop: 8,
      textAlign: "center",
    },
  });
}
