/**
 * ProvingProgress — animated progress bar for the ZK proof generation stage.
 *
 * Shown on the proving step of the shield / private-send / unshield screens.
 * The bar animates smoothly between whatever `pct` value the prover reports
 * (0–100), using a spring so small discrete updates look fluid rather than
 * jumpy. The label cycles through phase descriptions to give the user a sense
 * of what is happening on-device.
 */

import { useEffect, useMemo, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';

export type ProvingProgressProps = {
  /** Completion percentage, 0–100. */
  pct: number;
};

/** Maps a progress percentage to a human-readable phase label. */
function phaseLabel(pct: number): string {
  if (pct < 20) return 'Building witness…';
  if (pct < 45) return 'Generating constraints…';
  if (pct < 85) return 'Computing proof…';
  if (pct < 100) return 'Verifying proof…';
  return 'Proof complete';
}

export function ProvingProgress({ pct }: ProvingProgressProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  // Animated width (0–1) that drives the fill bar.
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(progress, {
      toValue: pct / 100,
      useNativeDriver: false,
      friction: 10,
      tension: 60,
    }).start();
  }, [pct, progress]);

  return (
    <View style={styles.wrap}>
      {/* Track */}
      <View style={styles.track}>
        <Animated.View
          style={[
            styles.fill,
            {
              width: progress.interpolate({
                inputRange: [0, 1],
                outputRange: ['0%', '100%'],
                extrapolate: 'clamp',
              }),
            },
          ]}
        />
      </View>

      {/* Percentage + phase label */}
      <View style={styles.labelRow}>
        <Text style={styles.phase}>{phaseLabel(pct)}</Text>
        <Text style={styles.pct}>{pct}%</Text>
      </View>
    </View>
  );
}

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: {
      alignSelf: 'stretch',
      gap: 10,
    },
    track: {
      height: 6,
      borderRadius: 3,
      backgroundColor: 'rgba(253,218,36,0.12)',
      overflow: 'hidden',
    },
    fill: {
      height: '100%',
      borderRadius: 3,
      backgroundColor: c.accent,
    },
    labelRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    phase: {
      fontFamily: fontFamily.bodyMedium,
      fontSize: 12,
      color: c.textMuted,
    },
    pct: {
      fontFamily: fontFamily.address,
      fontSize: 12,
      color: c.accentText,
    },
  });
