import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { GridIcon, SwapVerticalIcon, type IconProps } from './icons';

/**
 * The actions behind the tab bar's `+`.
 *
 * This exists so the bar stops being the only way to reach a whole class of
 * things. Swap sat in the bar as if it were a destination, and dApp discovery
 * was buried in Settings — a page about preferences, which browsing apps is
 * not. Both are *actions you take*, and they now live together in one place
 * that can grow without the bar growing with it.
 *
 * Adding an action is one entry here. The bar does not change.
 */

export type MoreAction = {
  key: string;
  label: string;
  /** One line under the label. Say what it does, not what it is. */
  hint: string;
  Icon: (p: IconProps) => React.JSX.Element;
  route: Href;
  /** Optional pill, e.g. "New". Keep it rare or it stops meaning anything. */
  badge?: string;
};

export const MORE_ACTIONS: MoreAction[] = [
  {
    key: 'swap',
    label: 'Swap',
    hint: 'Exchange between tokens',
    Icon: SwapVerticalIcon,
    route: '/swap',
  },
  {
    key: 'dapps',
    label: 'Discover dApps',
    hint: 'Browse the Stellar apps Veil can open',
    Icon: GridIcon,
    route: '/dapps',
  },
];

export function MoreActionsSheet({
  visible,
  onClose,
  actions = MORE_ACTIONS,
}: {
  visible: boolean;
  onClose: () => void;
  actions?: MoreAction[];
}) {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  // The Modal's own mount is driven from here rather than from `visible`.
  // Binding it straight to the prop unmounts the panel on the frame the close
  // begins, so the exit animation is never seen.
  const [mounted, setMounted] = useState(visible);
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.timing(anim, {
        toValue: 1,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      return;
    }
    Animated.timing(anim, {
      toValue: 0,
      duration: 160,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) setMounted(false);
    });
  }, [visible, anim]);

  const go = useCallback(
    (route: Href) => {
      // Close first, then navigate on the next tick. Pushing while the Modal is
      // still up leaves it over the screen it just opened.
      onClose();
      setTimeout(() => router.push(route), 120);
    },
    [onClose, router],
  );

  if (!mounted) return null;

  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [320, 0] });

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        <Animated.View style={[styles.backdrop, { opacity: anim }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close menu"
          />
        </Animated.View>

        <Animated.View style={[styles.panel, { transform: [{ translateY }] }]}>
          <View style={styles.grabber} />
          {actions.map((action) => (
            <Pressable
              key={action.key}
              onPress={() => go(action.route)}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            >
              <View style={styles.rowIcon}>
                <action.Icon size={20} color={colors.accent} />
              </View>
              <View style={styles.rowText}>
                <View style={styles.rowTitleLine}>
                  <Text style={styles.rowLabel}>{action.label}</Text>
                  {action.badge ? (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>{action.badge}</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={styles.rowHint}>{action.hint}</Text>
              </View>
            </Pressable>
          ))}
        </Animated.View>
      </View>
    </Modal>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    root: { flex: 1, justifyContent: 'flex-end' },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)' },
    panel: {
      backgroundColor: colors.surfaceRaised,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      paddingHorizontal: 20,
      // Clears the floating tab bar, which sits 24 from the bottom.
      paddingBottom: 110,
      paddingTop: 10,
      gap: 4,
    },
    grabber: {
      alignSelf: 'center',
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.border,
      marginBottom: 14,
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14 },
    rowIcon: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceMd,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    rowText: { flex: 1, gap: 2 },
    rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    rowLabel: { color: colors.textStrong, fontFamily: fontFamily.bodySemiBold, fontSize: 16 },
    rowHint: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13 },
    badge: {
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 999,
      backgroundColor: colors.surfaceMd,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    badgeText: {
      color: colors.accent,
      fontFamily: fontFamily.accent,
      fontSize: 10,
      letterSpacing: 0.8,
    },
    pressed: { opacity: 0.6 },
  });
