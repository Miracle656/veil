import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

import { useTheme } from "../hooks/useTheme";

export default function RootLayout() {
  const { colors, isDark } = useTheme();

  return (
    <>
      <Stack
        screenOptions={{
          headerShown: false,
          // Painted behind every route, so a screen that is still loading (or
          // shorter than the viewport) never shows the opposite theme.
          contentStyle: { backgroundColor: colors.background },
        }}
      />
      <StatusBar style={isDark ? "light" : "dark"} />
    </>
  );
}
