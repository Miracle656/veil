import { Stack } from 'expo-router';

/**
 * Privacy sub-navigator — shield / private-send / unshield all live here as
 * full-screen Stack routes that push over the tab bar, matching the pattern
 * used by /send, /receive, and /swap.  `headerShown: false` everywhere so each
 * screen owns its header via FlowHeader.
 */
export default function PrivacyLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
      <Stack.Screen name="shield" />
      <Stack.Screen name="send" />
      <Stack.Screen name="unshield" />
    </Stack>
  );
}
