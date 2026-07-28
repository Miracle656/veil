import { Text, type ColorValue } from 'react-native';
import { colors } from './ScreenScaffold';

/**
 * Tab bar icon set built from Unicode glyphs.
 *
 * The mobile app doesn't depend on react-native-svg or any icon library yet,
 * so we use cross-platform Unicode symbols from the Geometric Shapes and
 * Miscellaneous Symbols blocks. Glyphs (not emoji) are picked so rendering
 * stays consistent across iOS, Android, and web.
 */

export type TabIconName = 'dashboard' | 'send' | 'receive' | 'settings';

const GLYPHS: Record<TabIconName, string> = {
  dashboard: '⊞', // grid
  send: '↑',      // up arrow
  receive: '↓',   // down arrow
  settings: '⚙',  // gear (miscellaneous symbol, non-emoji variant)
};

export function TabIcon({ name, color }: { name: TabIconName; color: ColorValue }) {
  return (
    <Text
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{
        color,
        fontSize: 22,
        lineHeight: 24,
        // Match the focused / unfocused tone used by the tab bar
        opacity: color === colors.gold ? 1 : 0.85,
      }}
    >
      {GLYPHS[name]}
    </Text>
  );
}
