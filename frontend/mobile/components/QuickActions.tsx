import { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { BuyIcon, ReceiveIcon, SendIcon, SwapIcon, type IconProps } from './icons';

export interface QuickActionItem {
  id: string;
  label: string;
  route: Href;
  Icon: (props: IconProps) => React.JSX.Element;
  accessibilityLabel: string;
}

export const QUICK_ACTIONS: QuickActionItem[] = [
  { id: 'send', label: 'Send', route: '/send', Icon: SendIcon, accessibilityLabel: 'Navigate to Send screen' },
  { id: 'receive', label: 'Receive', route: '/receive', Icon: ReceiveIcon, accessibilityLabel: 'Navigate to Receive screen' },
  { id: 'swap', label: 'Swap', route: '/swap', Icon: SwapIcon, accessibilityLabel: 'Navigate to Swap screen' },
  { id: 'buy', label: 'Buy', route: '/buy', Icon: BuyIcon, accessibilityLabel: 'Navigate to Buy screen' },
];

export interface QuickActionsProps {
  actions?: QuickActionItem[];
  onActionPress?: (action: QuickActionItem) => void;
}

/**
 * The dashboard's primary-action grid — Send / Receive / Swap / Buy.
 *
 * Matches the redesign artboard: four equal tiles on a raised surface, each with
 * a gold line icon over an Inter label. Colours come from the theme, so the grid
 * follows light/dark and the Veil brand rather than hard-coded values.
 */
export function QuickActions({ actions = QUICK_ACTIONS, onActionPress }: QuickActionsProps) {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const handlePress = (action: QuickActionItem) => {
    if (onActionPress) onActionPress(action);
    else router.push(action.route);
  };

  return (
    <View style={styles.container} testID="quick-actions-grid">
      {actions.map((action) => (
        <TouchableOpacity
          key={action.id}
          style={styles.actionBtn}
          onPress={() => handlePress(action)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={action.accessibilityLabel}
          testID={`quick-action-${action.id}`}
        >
          <action.Icon size={21} color={colors.accent} />
          <Text style={styles.label}>{action.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      flexDirection: 'row',
      gap: 10,
      width: '100%',
      marginVertical: 14,
    },
    actionBtn: {
      flex: 1,
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingVertical: 15,
      paddingHorizontal: 4,
      backgroundColor: colors.surfaceMd,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 16,
    },
    label: {
      color: colors.textPrimary,
      fontFamily: fontFamily.bodyMedium,
      fontSize: 12.5,
    },
  });

export default QuickActions;
