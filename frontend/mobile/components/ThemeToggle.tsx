import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { useTheme } from '../hooks/useTheme';

/**
 * Round light/dark switch, ported from `frontend/wallet/components/ThemeToggle.tsx`.
 *
 * Same behaviour as the web control: it shows the icon of the mode you would
 * switch *to*, so a sun in dark mode and a moon in light mode. The icon
 * geometry is the web component's, redrawn with `react-native-svg`.
 */
export function ThemeToggle({ style }: { style?: StyleProp<ViewStyle> }) {
  const { isDark, colors, toggle } = useTheme();

  return (
    <Pressable
      onPress={toggle}
      accessibilityRole="switch"
      accessibilityState={{ checked: isDark }}
      accessibilityLabel={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      hitSlop={8}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: colors.surface, borderColor: colors.border },
        pressed && styles.pressed,
        style,
      ]}
    >
      {isDark ? <SunIcon color={colors.textPrimary} /> : <MoonIcon color={colors.textPrimary} />}
    </Pressable>
  );
}

function SunIcon({ color }: { color: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 18 18" fill="none">
      <Circle cx="9" cy="9" r="3.5" stroke={color} strokeWidth={1.5} />
      {[
        [9, 1, 9, 3],
        [9, 15, 9, 17],
        [1, 9, 3, 9],
        [15, 9, 17, 9],
        [3.22, 3.22, 4.64, 4.64],
        [13.36, 13.36, 14.78, 14.78],
        [14.78, 3.22, 13.36, 4.64],
        [4.64, 13.36, 3.22, 14.78],
      ].map(([x1, y1, x2, y2]) => (
        <Line
          key={`${x1}-${y1}`}
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke={color}
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      ))}
    </Svg>
  );
}

function MoonIcon({ color }: { color: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 18 18" fill="none">
      <Path
        d="M15.5 10.5A7 7 0 1 1 7.5 2.5a5 5 0 0 0 8 8z"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  pressed: {
    opacity: 0.7,
  },
});
