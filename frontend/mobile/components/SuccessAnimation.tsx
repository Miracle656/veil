import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';

import { useTheme } from '../hooks/useTheme';
import { fontFamily } from '../theme/typography';
import { CheckIcon, PaperPlaneIcon, type IconProps } from './icons';

/**
 * Completion flourish for send / swap: an icon buzzes in place ("flying with
 * speed on a spot"), then morphs into a check mark, with a haptic tap on launch
 * and a success haptic when the check lands. Plays once on mount.
 */
export function SuccessAnimation({
  title,
  subtitle,
  FromIcon = PaperPlaneIcon,
}: {
  title: string;
  subtitle?: string;
  FromIcon?: (p: IconProps) => React.JSX.Element;
}) {
  const { colors } = useTheme();

  const fly = useRef(new Animated.Value(0)).current; // -1..1 buzz
  const morph = useRef(new Animated.Value(0)).current; // 0 = plane, 1 = check
  const pop = useRef(new Animated.Value(0)).current; // ring entrance

  useEffect(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);

    Animated.spring(pop, { toValue: 1, useNativeDriver: true, friction: 6, tension: 90 }).start();

    // Buzz the plane for ~0.7s, then morph into the check.
    const buzz = Animated.loop(
      Animated.sequence([
        Animated.timing(fly, { toValue: 1, duration: 80, easing: Easing.linear, useNativeDriver: true }),
        Animated.timing(fly, { toValue: -1, duration: 80, easing: Easing.linear, useNativeDriver: true }),
      ]),
      { iterations: 4 },
    );
    buzz.start(() => {
      fly.setValue(0);
      Animated.spring(morph, { toValue: 1, useNativeDriver: true, friction: 5, tension: 90 }).start(() => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      });
    });

    return () => buzz.stop();
  }, [fly, morph, pop]);

  const ringScale = pop.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] });
  const planeTranslate = fly.interpolate({ inputRange: [-1, 1], outputRange: [-5, 5] });
  const planeRotate = fly.interpolate({ inputRange: [-1, 1], outputRange: ['-10deg', '10deg'] });
  const planeOpacity = morph.interpolate({ inputRange: [0, 0.4, 1], outputRange: [1, 0, 0] });
  const planeScale = morph.interpolate({ inputRange: [0, 1], outputRange: [1, 0.3] });
  const checkOpacity = morph.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 0, 1] });
  const checkScale = morph.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] });

  return (
    <View style={styles.wrap}>
      <Animated.View style={[styles.ring, { backgroundColor: colors.accent, transform: [{ scale: ringScale }] }]}>
        <Animated.View
          style={[styles.abs, { opacity: planeOpacity, transform: [{ translateX: planeTranslate }, { rotate: planeRotate }, { scale: planeScale }] }]}
        >
          <FromIcon size={40} color={colors.onAccent} />
        </Animated.View>
        <Animated.View style={[styles.abs, { opacity: checkOpacity, transform: [{ scale: checkScale }] }]}>
          <CheckIcon size={46} color={colors.onAccent} strokeWidth={2.6} />
        </Animated.View>
      </Animated.View>
      <Text style={[styles.title, { color: colors.textStrong }]}>{title}</Text>
      {subtitle ? <Text style={[styles.subtitle, { color: colors.textMuted }]}>{subtitle}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 16 },
  ring: {
    width: 104,
    height: 104,
    borderRadius: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  abs: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: fontFamily.heading, fontSize: 24 },
  subtitle: { fontFamily: fontFamily.body, fontSize: 14, textAlign: 'center' },
});
