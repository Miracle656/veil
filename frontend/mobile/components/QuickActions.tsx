import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useRouter, Href } from "expo-router";

export interface QuickActionItem {
  id: string;
  label: string;
  route: Href;
  iconSymbol: string;
  accessibilityLabel: string;
}

export const QUICK_ACTIONS: QuickActionItem[] = [
  {
    id: "send",
    label: "Send",
    route: "/send",
    iconSymbol: "↗",
    accessibilityLabel: "Navigate to Send screen",
  },
  {
    id: "receive",
    label: "Receive",
    route: "/receive",
    iconSymbol: "↙",
    accessibilityLabel: "Navigate to Receive screen",
  },
  {
    id: "swap",
    label: "Swap",
    route: "/swap",
    iconSymbol: "⇄",
    accessibilityLabel: "Navigate to Swap screen",
  },
  {
    id: "buy",
    label: "Buy",
    route: "/buy",
    iconSymbol: "$",
    accessibilityLabel: "Navigate to Buy screen",
  },
];

export interface QuickActionsProps {
  actions?: QuickActionItem[];
  onActionPress?: (action: QuickActionItem) => void;
}

export function QuickActions({
  actions = QUICK_ACTIONS,
  onActionPress,
}: QuickActionsProps) {
  const router = useRouter();

  const handlePress = (action: QuickActionItem) => {
    if (onActionPress) {
      onActionPress(action);
    } else {
      router.push(action.route);
    }
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
          <View style={styles.iconContainer}>
            <Text style={styles.iconText}>{action.iconSymbol}</Text>
          </View>
          <Text style={styles.label}>{action.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
    width: "100%",
    marginVertical: 16,
  },
  actionBtn: {
    flex: 1,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    paddingHorizontal: 4,
    backgroundColor: "rgba(253, 218, 36, 0.06)",
    borderWidth: 1,
    borderColor: "rgba(253, 218, 36, 0.18)",
    borderRadius: 14,
  },
  iconContainer: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(253, 218, 36, 0.12)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  iconText: {
    color: "#FDDA24",
    fontSize: 18,
    fontWeight: "600",
  },
  label: {
    color: "#F6F7F8",
    fontSize: 13,
    fontWeight: "500",
  },
});

export default QuickActions;
