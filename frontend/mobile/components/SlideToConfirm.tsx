import { useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, StyleSheet, View } from 'react-native';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { SendIcon } from './icons';

const TRACK_HEIGHT = 62;
const THUMB = 52;
const EDGE = 5; // thumb inset from the track edge

/**
 * Slide-to-confirm — the design's deliberate gesture before a signature fires.
 * Drag the gold thumb to the end and `onConfirm` runs (which is where Face ID /
 * the passkey ceremony is triggered). Nothing moves the money until the user
 * physically completes the slide.
 *
 * Self-measuring: the travel distance comes from onLayout, so it fits any width.
 * Once confirmed it stays parked at the end and ignores further drags until the
 * parent unmounts/remounts it (a new confirmation).
 */
export function SlideToConfirm({
  label = 'Slide to confirm',
  onConfirm,
  disabled = false,
}: {
  label?: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [trackWidth, setTrackWidth] = useState(0);
  const maxTravel = Math.max(0, trackWidth - THUMB - EDGE * 2);

  const x = useRef(new Animated.Value(0)).current;
  const confirmed = useRef(false);
  const startX = useRef(0);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !disabled && !confirmed.current,
        onMoveShouldSetPanResponder: () => !disabled && !confirmed.current,
        onPanResponderGrant: () => {
          x.stopAnimation((v) => {
            startX.current = v;
          });
        },
        onPanResponderMove: (_e, g) => {
          const next = Math.min(maxTravel, Math.max(0, startX.current + g.dx));
          x.setValue(next);
        },
        onPanResponderRelease: (_e, g) => {
          const next = Math.min(maxTravel, Math.max(0, startX.current + g.dx));
          if (next >= maxTravel * 0.85) {
            confirmed.current = true;
            Animated.timing(x, { toValue: maxTravel, duration: 120, useNativeDriver: false }).start(() => {
              onConfirm();
            });
          } else {
            Animated.spring(x, { toValue: 0, useNativeDriver: false, friction: 7 }).start();
          }
        },
      }),
    [disabled, maxTravel, onConfirm, x],
  );

  const labelOpacity = x.interpolate({
    inputRange: [0, Math.max(1, maxTravel * 0.6)],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  return (
    <View
      style={[styles.track, disabled && styles.trackDisabled]}
      onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
    >
      <Animated.Text style={[styles.label, { opacity: labelOpacity }]} numberOfLines={1}>
        {label}
      </Animated.Text>
      <Animated.View
        {...pan.panHandlers}
        style={[styles.thumb, { transform: [{ translateX: x }] }]}
        accessibilityRole="adjustable"
        accessibilityLabel={label}
      >
        <SendIcon size={22} color={colors.onAccent} strokeWidth={2.2} />
      </Animated.View>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    track: {
      height: TRACK_HEIGHT,
      borderRadius: TRACK_HEIGHT / 2,
      borderWidth: 1,
      borderColor: 'rgba(253,218,36,0.35)',
      backgroundColor: 'rgba(253,218,36,0.05)',
      justifyContent: 'center',
      alignItems: 'center',
    },
    trackDisabled: {
      opacity: 0.5,
    },
    label: {
      color: colors.textSecondary,
      fontFamily: fontFamily.bodyMedium,
      fontSize: 14,
      letterSpacing: 0.4,
    },
    thumb: {
      position: 'absolute',
      left: EDGE,
      width: THUMB,
      height: THUMB,
      borderRadius: THUMB / 2,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
