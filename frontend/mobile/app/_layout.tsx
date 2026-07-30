import { useEffect, useRef } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { StyleSheet } from 'react-native';

import { fontAssets } from '../theme/typography';
import { useTheme } from '../hooks/useTheme';
import { ConnectivityProvider, useConnectivity } from '../lib/connectivity';
import { hydrateNetwork } from '../lib/network';
import { hydrateLockSettings } from '../lib/appLock';
import { WalletConnectApprovalModal } from '../components/WalletConnectApprovalModal';

// Hold the native splash screen until the brand fonts are ready, so the UI
// never flashes a system font on first paint.
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const { colors, isDark } = useTheme();
  const [fontsLoaded, fontError] = useFonts(fontAssets);

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  // Apply any persisted network override before the first screen reads
  // getNetwork(). Without this the app always starts on the build-time network
  // and a saved choice would only take effect after the user re-picked it.
  useEffect(() => {
    void hydrateNetwork();
    // Same reason as the network override: without this the app starts on the
    // defaults and a saved lock timeout only takes effect once re-picked.
    void hydrateLockSettings();
  }, []);

  // Keep the splash screen up (render nothing) until the fonts resolve — either
  // loaded, or failed, in which case we fall back to system fonts rather than
  // blocking the app forever.
  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    // GestureHandlerRootView + BottomSheetModalProvider are required by the
    // @gorhom bottom sheets used for the transaction detail surface.
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <BottomSheetModalProvider>
          <ConnectivityProvider>
            <ConnectivityGate />
            <Stack
              screenOptions={{
                headerShown: false,
                // Painted behind every route, so a screen that is still loading (or
                // shorter than the viewport) never shows the opposite theme.
                contentStyle: { backgroundColor: colors.background },
              }}
            />
            {/* Mounted once at the root so a dApp request is presented for approval
            no matter which screen the user is on. */}
            <WalletConnectApprovalModal />
            <StatusBar style={isDark ? 'light' : 'dark'} />
          </ConnectivityProvider>
        </BottomSheetModalProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});

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
  const isOnOfflineRoute = segments[0] === 'offline';

  useEffect(() => {
    if (!isOnline) {
      if (!isOnOfflineRoute && !pushedRef.current) {
        pushedRef.current = true;
        router.push('/offline');
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
