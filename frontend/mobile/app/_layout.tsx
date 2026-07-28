import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef } from "react";
import { ConnectivityProvider, useConnectivity } from "../lib/connectivity";

export default function RootLayout() {
  return (
    <ConnectivityProvider>
      <ConnectivityGate />
      <Stack screenOptions={{ headerShown: false }} />
      <StatusBar style="light" />
    </ConnectivityProvider>
  );
}

/**
 * Pushes the offline screen when connectivity drops and pops it again when it
 * returns, so the route the user was on is preserved underneath. Rendered as a
 * sibling of the navigator rather than around it, so it can use the router.
 */
function ConnectivityGate() {
  const { isOnline } = useConnectivity();
  const router = useRouter();
  const segments = useSegments();

  // Only pop the offline screen if this gate is what pushed it.
  const pushedRef = useRef(false);
  const isOnOfflineRoute = segments[0] === "offline";

  useEffect(() => {
    if (!isOnline) {
      if (!isOnOfflineRoute && !pushedRef.current) {
        pushedRef.current = true;
        router.push("/offline");
      }
      return;
    }

    if (pushedRef.current) {
      pushedRef.current = false;
      if (isOnOfflineRoute && router.canGoBack()) {
        router.back();
      }
    }
  }, [isOnOfflineRoute, isOnline, router]);

  return null;
}
