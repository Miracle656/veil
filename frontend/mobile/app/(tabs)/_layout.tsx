import { Tabs } from 'expo-router';

import { VeilTabBar } from '../../components/VeilTabBar';

/**
 * Bottom tabs — Home / Earn / Agent / Settings, with the redesign's raised gold
 * "+" (the universal pay/send action) rendered by VeilTabBar between Earn and
 * Agent. Send / Receive are push routes at the app root (they open over the tabs
 * as full-screen flows, without the tab bar), reached from the + and from the
 * balance card.
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
