import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View, type ViewStyle } from 'react-native';

/**
 * A placeholder block that pulses while real content loads.
 *
 * Preferred over a spinner wherever the shape of what is coming is already
 * known. A spinner says "something is happening"; a skeleton says "a balance
 * goes here, and it is about this big" — so the layout does not jump when the
 * value lands, and the wait reads as shorter than it is.
 *
 * The pulse is opacity-only and driven by the native driver, so it costs no
 * JS-thread work while the screen is also fetching, parsing and rendering.
 * `reduceMotion` renders a flat block for anyone who does not want movement.
 */
export function Skeleton({
  width,
  height = 14,
  radius = 6,
  style,
  reduceMotion = false,
}: {
  width: number | `${number}%`;
  height?: number;
  radius?: number;
  style?: ViewStyle;
  reduceMotion?: boolean;
}) {
  const pulse = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    if (reduceMotion) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.85,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.4,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduceMotion]);

  const base: ViewStyle = { width, height, borderRadius: radius };

  if (reduceMotion) {
    return <View style={[styles.block, base, style]} />;
  }

  return <Animated.View style={[styles.block, base, style, { opacity: pulse }]} />;
}

const styles = StyleSheet.create({
  block: {
    // Neutral and translucent so the same component reads correctly on the
    // silver card and on the dark screen background without being re-themed.
    backgroundColor: 'rgba(0,0,0,0.10)',
  },
});
