import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { useTheme } from "../hooks/useTheme";
import type { ThemeColors } from "../lib/theme";
import { fontFamily } from "../theme/typography";
import { VeilLogo } from "../components/VeilLogo";
import { getWalletAddress, getSignerSecret, getPasskeyId } from "../lib/walletStore";

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
      // A wallet only counts as usable when there's a SIGNER (keypair secret or
      // a registered passkey) — an address with neither is a stale preview stub
      // that can't sign, so we route such state back to onboarding.
      const [address, secret, passkeyId, seenWelcome] = await Promise.all([
        getWalletAddress(),
        getSignerSecret(),
        getPasskeyId(),
        AsyncStorage.getItem(SEEN_WELCOME_KEY),
      ]);
      const wallet = address && (secret || passkeyId) ? address : null;
      return { wallet, seenWelcome };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

/**
 * App entry — the splash (design "4a"). The Drape mark breathes on near-black
 * while the wallet state is read, then routes to the dashboard (wallet exists)
 * or the welcome landing (no wallet yet).
 */
export default function Index() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const navigated = useRef(false);
  const [, setLoading] = useState(true);

  // Slow breathing pulse on the mark while we resolve entry state.
  const breathe = useRef(new Animated.Value(0.35)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, { toValue: 1, duration: 950, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(breathe, { toValue: 0.35, duration: 950, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [breathe]);

  useEffect(() => {
    (async () => {
      try {
        const { wallet } = await readEntryState();
        if (navigated.current) return;
        navigated.current = true;
        router.replace(wallet ? "/dashboard" : "/welcome");
      } catch {
        if (navigated.current) return;
        navigated.current = true;
        router.replace("/welcome");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.mark, { opacity: breathe }]}>
        <VeilLogo size={96} color={colors.accent} />
      </Animated.View>
      <Text style={styles.wordmark}>VEIL</Text>
      <Text style={styles.status}>Securing your session…</Text>
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
    },
    mark: {
      marginBottom: 4,
    },
    wordmark: {
      fontFamily: fontFamily.accent,
      fontSize: 30,
      letterSpacing: 2.4,
      color: colors.accent,
      marginTop: 24,
    },
    status: {
      position: "absolute",
      bottom: 64,
      fontFamily: fontFamily.address,
      fontSize: 12,
      color: colors.textFaint,
    },
  });
