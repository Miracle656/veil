import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import {
  AgentIcon,
  SettingsIcon,
  PlusIcon,
  WalletIcon,
  YieldIcon,
  type IconProps,
} from './icons';
import { MoreActionsSheet } from './MoreActionsSheet';

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
  const [moreOpen, setMoreOpen] = useState(false);
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
    <>
      <View style={styles.wrap} pointerEvents="box-none">
        <View style={[styles.bar, { backgroundColor: barBg }]}>
          {renderTab('dashboard')}
          {renderTab('earn')}
          {/* The action slot: raised, gold, and not a destination.

              Swap used to sit here as though it were one of the places the app
              goes. It is something you do — and so is browsing dApps, which was
              buried in Settings, a page about preferences. This opens a sheet
              holding both, and the list can grow without the bar growing.

              Raised deliberately. The earlier objection to a FAB here was that
              it gave *Swap* the weight of the app's primary action, which Swap
              is not. A + makes no such claim: it opens a menu, and lifting it
              is what tells you it does something rather than goes somewhere. */}
          <Pressable
            onPress={() => setMoreOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="More actions"
            style={({ pressed }) => [styles.tab, pressed && styles.pressed]}
          >
            <View style={styles.fab}>
              <PlusIcon size={24} color={colors.onAccent} strokeWidth={2.6} />
            </View>
            <Text style={[styles.label, styles.fabLabel]} numberOfLines={1}>
              More
            </Text>
          </Pressable>
          {renderTab('agent')}
          {renderTab('settings')}
        </View>
      </View>
      <MoreActionsSheet visible={moreOpen} onClose={() => setMoreOpen(false)} />
    </>
  );
}

function Tab({
  label,
  Icon,
  focused,
  tint,
  colors,
  styles,
  onPress,
}: {
  label: string;
  Icon: (p: IconProps) => React.JSX.Element;
  focused: boolean;
  /** Overrides the focused/unfocused colour, for the action slot. */
  tint?: string;
  colors: ThemeColors;
  styles: ReturnType<typeof createStyles>;
  onPress: () => void;
}) {
  const color = tint ?? (focused ? colors.accent : colors.textFaint);
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
    // Lifted clear of the pill. The bar sets no overflow, so the circle breaks
    // its top edge instead of being clipped by it.
    fab: {
      width: 50,
      height: 50,
      borderRadius: 25,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accent,
      marginTop: -28,
      marginBottom: 2,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.3,
      shadowRadius: 12,
      elevation: 8,
    },
    fabLabel: {
      fontFamily: fontFamily.bodySemiBold,
      color: colors.accent,
    },
    pressed: {
      opacity: 0.6,
    },
  });
