import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

/**
 * Root layout. Wraps the Stack in a SafeAreaProvider so every screen
 * scaffold can read real `insets` via `useSafeAreaInsets()`. The
 * `<StatusBar style="light">` keeps dark-on-white readable on iOS when
 * the system falls back to a light status bar style.
 */
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <Stack screenOptions={{ headerShown: false }} />
      <StatusBar style="light" />
    </SafeAreaProvider>
  );
}
