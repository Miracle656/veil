import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { fontAssets } from "../theme/typography";
import { useTheme } from "../hooks/useTheme";

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

  // Keep the splash screen up (render nothing) until the fonts resolve — either
  // loaded, or failed, in which case we fall back to system fonts rather than
  // blocking the app forever.
  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    <SafeAreaProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          // Painted behind every route, so a screen that is still loading (or
          // shorter than the viewport) never shows the opposite theme.
          contentStyle: { backgroundColor: colors.background },
        }}
      />
      <StatusBar style={isDark ? "light" : "dark"} />
    </SafeAreaProvider>
  );
}
