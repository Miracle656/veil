import { Tabs } from 'expo-router';

import { VeilTabBar } from '../../components/VeilTabBar';

/**
 * Bottom tabs — Wallet / Earn / Agent / Settings, drawn by VeilTabBar as one
 * rounded pill with Swap sitting between Earn and Agent. Swap, Send and Receive
 * are push routes at the app root: they open over the tabs as full-screen flows
 * without the tab bar, reached from this bar and from the balance card.
 */
export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <VeilTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name="dashboard" options={{ title: 'Home' }} />
      <Tabs.Screen name="earn" options={{ title: 'Earn' }} />
      <Tabs.Screen name="agent" options={{ title: 'Agent' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  );
}
