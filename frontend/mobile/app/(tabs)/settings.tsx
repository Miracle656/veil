import { useState } from "react";
import { useRouter } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { AddressChip, Card, Screen } from "../../components/ui";
import { colors } from "../../theme/colors";
import { fontFamily, typography } from "../../theme/typography";

type SettingsRow = { key: string; title: string; subtitle: string; href?: string };
type SettingsGroup = { heading: string; rows: SettingsRow[] };

const SAMPLE_ADDRESS = "GA3DHM4WL2VXPHR7NQKPZ7XK9FQJ2ULTQ6ZT4W2M5N6Q7RSTUVWXK9FQ";

/**
 * Grouped settings sections, ported from the web wallet's settings page
 * (`frontend/wallet/app/settings/page.tsx`). Later settings issues fill each
 * section with real controls.
 */
const GROUPS: SettingsGroup[] = [
  {
    heading: "SECURITY",
    rows: [
      { key: "passkeys", title: "Passkeys", subtitle: "Manage passkeys registered on this wallet" },
      {
        key: "guardian",
        title: "Guardian recovery",
        subtitle: "Set a trusted account to recover access if you lose your device",
      },
      {
        key: "backup",
        title: "Paper backup",
        subtitle: "Generate an offline 12-word recovery phrase",
      },
      {
        key: "lock",
        title: "Security & lock",
        subtitle: "Auto-lock the wallet after inactivity",
        href: "/settings/security",
      },
    ],
  },
  {
    heading: "PREFERENCES",
    rows: [
      { key: "profile", title: "Profile & AI", subtitle: "Name, language, and agent personality" },
      { key: "agent", title: "Agent settings", subtitle: "Spending limits and allowed services" },
      { key: "privacy", title: "Privacy", subtitle: "Error reporting and data preferences" },
    ],
  },
  {
    heading: "GENERAL",
    rows: [
      { key: "contacts", title: "Address book", subtitle: "Saved recipients and labels" },
      { key: "about", title: "About", subtitle: "Version, licenses, and support" },
    ],
  },
];

export default function SettingsScreen() {
  // In-page navigation, mirroring the web page's section state: the shell shows
  // the grouped overview, and selecting a row opens that section's detail.
  const router = useRouter();
  const [active, setActive] = useState<SettingsRow | null>(null);

  if (active) {
    return (
      <Screen>
        <ScrollView contentContainerStyle={styles.content}>
          <Pressable
            onPress={() => setActive(null)}
            accessibilityRole="button"
            style={styles.back}
          >
            <Text style={styles.backText}>‹ Settings</Text>
          </Pressable>
          <Text style={[typography.heading, styles.title]}>{active.title}</Text>
          <Card variant="md" style={styles.placeholder}>
            <Text style={styles.placeholderText}>
              This section is configured in a later update.
            </Text>
          </Card>
        </ScrollView>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[typography.heading, styles.title]}>Settings</Text>
        <Text style={styles.subtitle}>Manage signers, recovery, and wallet preferences</Text>

        <Card style={styles.walletCard}>
          <Text style={styles.walletLabel}>WALLET</Text>
          <AddressChip address={SAMPLE_ADDRESS} />
        </Card>

        {GROUPS.map((group) => (
          <View key={group.heading} style={styles.group}>
            <Text style={styles.groupHeading}>{group.heading}</Text>
            <Card style={styles.groupCard}>
              {group.rows.map((row, i) => (
                <Pressable
                  key={row.key}
                  onPress={() => (row.href ? router.push(row.href as never) : setActive(row))}
                  accessibilityRole="button"
                  style={[styles.row, i > 0 && styles.rowDivider]}
                >
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle}>{row.title}</Text>
                    <Text style={styles.rowSubtitle}>{row.subtitle}</Text>
                  </View>
                  <Text style={styles.chevron}>›</Text>
                </Pressable>
              ))}
            </Card>
          </View>
        ))}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: 16,
    paddingVertical: 24,
  },
  title: {
    color: colors.offWhite,
  },
  subtitle: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    color: colors.textMuted,
    marginTop: -8,
  },
  walletCard: {
    padding: 16,
    gap: 10,
  },
  walletLabel: {
    fontFamily: fontFamily.accent,
    fontSize: 12,
    letterSpacing: 1,
    color: "rgba(246,247,248,0.4)",
  },
  group: {
    gap: 8,
  },
  groupHeading: {
    fontFamily: fontFamily.accent,
    fontSize: 12,
    letterSpacing: 1,
    color: colors.textMuted,
    marginLeft: 4,
  },
  groupCard: {
    padding: 0,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 16,
    paddingHorizontal: 16,
  },
  rowDivider: {
    borderTopWidth: 1,
    borderTopColor: colors.borderDim,
  },
  rowText: {
    flex: 1,
  },
  rowTitle: {
    fontFamily: fontFamily.bodyMedium,
    fontSize: 15,
    color: colors.offWhite,
  },
  rowSubtitle: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 18,
    color: "rgba(246,247,248,0.4)",
    marginTop: 3,
  },
  chevron: {
    fontSize: 20,
    color: "rgba(246,247,248,0.3)",
  },
  back: {
    alignSelf: "flex-start",
    paddingVertical: 4,
  },
  backText: {
    fontFamily: fontFamily.bodyMedium,
    fontSize: 15,
    color: colors.gold,
  },
  placeholder: {
    padding: 20,
  },
  placeholderText: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    color: colors.textMuted,
  },
});
