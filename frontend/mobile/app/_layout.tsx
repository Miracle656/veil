import { useEffect } from "react";
import * as Linking from "expo-linking";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { parseDeepLink } from "../lib/sep7";

/**
 * Handles inbound `web+stellar:pay?...` and `veil://pay?...` links (opened
 * cold via `getInitialURL`, or while the app is already running via the
 * `url` event) by routing to the send flow with the parsed fields pre-filled.
 */
function useSep7DeepLinks() {
  const router = useRouter();

  useEffect(() => {
    const openSendFlow = (url: string) => {
      const parsed = parseDeepLink(url);
      if (!parsed?.destination) return;

      router.push({
        pathname: "/send",
        params: Object.fromEntries(
          Object.entries(parsed).filter(([, v]) => v !== undefined)
        ) as Record<string, string>,
      });
    };

    Linking.getInitialURL().then((url) => {
      if (url) openSendFlow(url);
    });

    const subscription = Linking.addEventListener("url", ({ url }) => {
      openSendFlow(url);
    });

    return () => subscription.remove();
  }, [router]);
}

function RootNavigator() {
  useSep7DeepLinks();

  return (
    <>
      <Stack screenOptions={{ headerShown: false }} />
      <StatusBar style="light" />
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <RootNavigator />
    </SafeAreaProvider>
  );
}
