import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import {
  AgentIcon,
  SettingsIcon,
  SwapVerticalIcon,
  WalletIcon,
  YieldIcon,
  type IconProps,
} from './icons';

type TabMeta = { label: string; Icon: (p: IconProps) => React.JSX.Element };

const META: Record<string, TabMeta> = {
  // "Wallet", not "Home" — the tab is the user's money, not a landing page.
  dashboard: { label: 'Wallet', Icon: WalletIcon },
  earn: { label: 'Earn', Icon: YieldIcon },
  agent: { label: 'Agent', Icon: AgentIcon },
  settings: { label: 'Settings', Icon: SettingsIcon },
};

/**
 * The floating tab bar: a single rounded pill of five evenly-weighted tabs,
 * following the Iconly crypto-nav reference.
 *
 * It replaced a version with a raised gold FAB for Swap in the middle. The FAB
 * gave Swap the visual weight of the app's primary action, which it isn't —
 * sending and receiving are — and it forced 34px of dead space above the bar to
 * make room for the circle. Flat tabs read as what they are: five places to go.
 *
 * Active state is colour and weight, not a shape change: accent icon at a
 * heavier stroke with a semibold label, against muted thin-stroke labels. That
 * keeps every tab the same size, so nothing shifts as you move between them.
 *
 * Rendered as the expo-router Tabs `tabBar`, so Wallet/Earn/Agent/Settings are
 * real tab screens with their state preserved, while Swap pushes over them.
 * Order is fixed here rather than taken from `state.routes`, so Swap always
 * lands dead centre regardless of registration order.
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
    return (
      <Tab
        key={name}
        label={meta.label}
        Icon={meta.Icon}
        focused={focused}
        colors={colors}
        styles={styles}
        onPress={() => navigation.navigate(name)}
      />
    );
  };

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <View style={[styles.bar, { backgroundColor: barBg }]}>
        {renderTab('dashboard')}
        {renderTab('earn')}
        {/* Swap is a pushed screen, not a tab, so it is never the focused one —
            it reads as the action it is. */}
        <Tab
          label="Swap"
          Icon={SwapVerticalIcon}
          focused={false}
          colors={colors}
          styles={styles}
          onPress={() => router.push('/swap')}
        />
        {renderTab('agent')}
        {renderTab('settings')}
      </View>
    </View>
  );
}

function Tab({
  label,
  Icon,
  focused,
  colors,
  styles,
  onPress,
}: {
  label: string;
  Icon: (p: IconProps) => React.JSX.Element;
  focused: boolean;
  colors: ThemeColors;
  styles: ReturnType<typeof createStyles>;
  onPress: () => void;
}) {
  const color = focused ? colors.accent : colors.textFaint;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={label}
      style={({ pressed }) => [styles.tab, pressed && styles.pressed]}
    >
      <Icon size={22} color={color} strokeWidth={focused ? 2 : 1.6} />
      <Text style={[styles.label, focused && styles.labelActive, { color }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
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
      paddingHorizontal: 16,
      paddingBottom: 24,
      paddingTop: 8,
    },
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      alignSelf: 'stretch',
      backgroundColor: colors.surfaceMd,
      borderWidth: 1,
      borderColor: colors.border,
      // Fully rounded: any radius at least half the bar's height reads as a
      // pill, and stays one as the height changes with the font scale.
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 10,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.18,
      shadowRadius: 18,
      elevation: 10,
    },
    tab: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 5,
      paddingVertical: 2,
    },
    label: {
      fontFamily: fontFamily.body,
      fontSize: 10,
    },
    labelActive: {
      fontFamily: fontFamily.bodySemiBold,
    },
    pressed: {
      opacity: 0.6,
    },
  });
