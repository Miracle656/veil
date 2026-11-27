import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

/**
 * The Drape mark, forming.
 *
 * Same geometry as {@link VeilLogo} — bars at 52/40/28 wide on a 96 grid, each
 * 12 tall with a 6 radius, at opacity 1 / 0.5 / 0.22 — but the bars arrive one
 * after another from the top, which is what the mark depicts: fabric falling.
 *
 * Built from Views rather than the SVG so each bar can animate independently.
 * The static mark stays the SVG; this exists only where the forming matters.
 *
 * The previous splash pulsed the whole mark's opacity, which read as a generic
 * loading throb and said nothing. Staggering the fall says the thing the logo
 * already means, and lands on the same three layers (fiat, USDC, yield) in the
 * order they stack.
 */

const GRID = 96;

/** x, y, width — straight from VeilLogo's rects. Height is 12, radius 6. */
const BARS: readonly { x: number; y: number; w: number; opacity: number }[] = [
  { x: 22, y: 26, w: 52, opacity: 1 },
  { x: 28, y: 44, w: 40, opacity: 0.5 },
  { x: 34, y: 62, w: 28, opacity: 0.22 },
];

/** Gap between one bar starting and the next. */
const STAGGER_MS = 130;
const FALL_MS = 420;

export function VeilLogoAnimated({
  size = 96,
  color = '#FDDA24',
  /** Replay from the top each time this changes — used to loop while waiting. */
  cycle = 0,
}: {
  size?: number;
  color?: string;
  cycle?: number;
}) {
  const scale = size / GRID;
  // One driver per bar, so each can carry its own delay.
  const progress = useRef(BARS.map(() => new Animated.Value(0))).current;

  useEffect(() => {
    progress.forEach((value) => value.setValue(0));
    const animation = Animated.stagger(
      STAGGER_MS,
      progress.map((value) =>
        Animated.timing(value, {
          toValue: 1,
          duration: FALL_MS,
          // Decelerate: the bar arrives and settles rather than snapping, which
          // is how cloth lands.
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ),
    );
    animation.start();
    return () => animation.stop();
  }, [cycle, progress]);

  return (
    <View style={{ width: size, height: size }}>
      {BARS.map((bar, i) => {
        const driver = progress[i];
        return (
          <Animated.View
            key={bar.y}
            style={[
              styles.bar,
              {
                left: bar.x * scale,
                top: bar.y * scale,
                width: bar.w * scale,
                height: 12 * scale,
                borderRadius: 6 * scale,
                backgroundColor: color,
                // Ends at the bar's own opacity from the static mark, so the
                // formed state is pixel-identical to VeilLogo.
                opacity: driver.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, bar.opacity],
                }),
                transform: [
                  {
                    translateY: driver.interpolate({
                      inputRange: [0, 1],
                      // Falls a little further than its own height, so the
                      // motion reads as descending rather than fading in place.
                      outputRange: [-14 * scale, 0],
                    }),
                  },
                ],
              },
            ]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { position: 'absolute' },
});
