import type { ColorValue } from 'react-native';

import { HomeIcon, ReceiveIcon, SendIcon, SettingsIcon, type IconProps } from './icons';

/**
 * Tab-bar icons, drawn with `react-native-svg` to match the redesign artboard's
 * line-icon set (replacing the earlier Unicode glyphs). The tab navigator passes
 * the focused/unfocused colour, so the icon just renders in that colour.
 */

export type TabIconName = 'dashboard' | 'send' | 'receive' | 'settings';

const ICONS: Record<TabIconName, (props: IconProps) => React.JSX.Element> = {
  dashboard: HomeIcon,
  send: SendIcon,
  receive: ReceiveIcon,
  settings: SettingsIcon,
};

export function TabIcon({ name, color }: { name: TabIconName; color: ColorValue }) {
  const Icon = ICONS[name];
  return <Icon size={22} color={String(color)} />;
}
