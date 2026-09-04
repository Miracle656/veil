import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { AgentIcon, EarnIcon, HomeIcon, SettingsIcon, SwapIcon, type IconProps } from './icons';

type TabMeta = { label: string; Icon: (p: IconProps) => React.JSX.Element };

const META: Record<string, TabMeta> = {
  dashboard: { label: 'Home', Icon: HomeIcon },
  earn: { label: 'Earn', Icon: EarnIcon },
  agent: { label: 'Agent', Icon: AgentIcon },
  settings: { label: 'Settings', Icon: SettingsIcon },
};

/**
 * The redesign's floating tab bar with a raised gold "+" in the middle — the
 * universal pay/send action. Home / Earn sit left of it, Agent / Settings right.
 *
 * Rendered as the expo-router Tabs `tabBar`, so Home/Earn/Agent/Settings are real
 * tab screens (state preserved), while the center + pushes the send flow over
 * them. Only the four registered tabs are drawn — order is fixed here so the +
 * always lands dead center regardless of registration order.
 */
export function VeilTabBar({ state, navigation }: BottomTabBarProps) {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  // Near-opaque so page content doesn't show through the floating bar.
  const barBg = isDark ? 'rgba(22,22,22,0.97)' : 'rgba(246,247,248,0.97)';

  const activeName = state.routes[state.index]?.name;

  const renderTab = (name: string) => {
    const meta = META[name];
    if (!meta) return null;
    const focused = activeName === name;
    const color = focused ? colors.accent : colors.textFaint;
    return (
      <Pressable
        key={name}
        onPress={() => navigation.navigate(name)}
        accessibilityRole="button"
        accessibilityState={{ selected: focused }}
        accessibilityLabel={meta.label}
        style={styles.tab}
      >
        <meta.Icon size={22} color={color} />
        <Text style={[styles.label, { color }]}>{meta.label}</Text>
      </Pressable>
    );
  };

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <View style={[styles.bar, { backgroundColor: barBg }]}>
        {renderTab('dashboard')}
        {renderTab('earn')}
        <Pressable
          onPress={() => router.push('/swap')}
          accessibilityRole="button"
          accessibilityLabel="Swap"
          style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
        >
          <SwapIcon size={26} color={colors.onAccent} strokeWidth={2.2} />
        </Pressable>
        {renderTab('agent')}
        {renderTab('settings')}
      </View>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    wrap: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingBottom: 28,
      // Room for the FAB poking above the bar.
      paddingTop: 34,
    },
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      alignSelf: 'stretch',
      backgroundColor: colors.surfaceMd,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 26,
      paddingHorizontal: 22,
      paddingVertical: 12,
    },
    tab: {
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      width: 56,
    },
    label: {
      fontFamily: fontFamily.bodyMedium,
      fontSize: 10,
    },
    fab: {
      width: 60,
      height: 60,
      borderRadius: 30,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: -40,
      borderWidth: 6,
      borderColor: colors.background,
      shadowColor: colors.accent,
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.35,
      shadowRadius: 16,
      elevation: 8,
    },
    fabPressed: {
      opacity: 0.85,
    },
  });
