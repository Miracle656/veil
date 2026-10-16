/**
 * Privacy settings — the mobile port of the web wallet's
 * `app/settings/privacy/page.tsx` (#830).
 *
 * The options, and whether each can be used, come from
 * `lib/privacy/settings.ts`, which reads the shared privacy flag in
 * `lib/privacy/config.ts`; nothing here decides availability itself. An option
 * the mobile app cannot act on is shown with a status badge instead of a
 * switch, so no control on this screen is a placebo.
 */

import { useMemo, useSyncExternalStore } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../../hooks/useTheme';
import { getNetworkName, subscribeToNetwork } from '../../lib/network';
import { getPrivacySettingsOptions } from '../../lib/privacy/settings';
import type { ThemeColors } from '../../lib/theme';

export default function PrivacySettingsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  // Re-evaluated on a network switch, so flipping to mainnet locks the screen
  // without leaving and re-entering it.
  const network = useSyncExternalStore(subscribeToNetwork, getNetworkName, getNetworkName);
  const options = useMemo(() => getPrivacySettingsOptions(network), [network]);

  return (
    <ScrollView showsVerticalScrollIndicator={false} style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Privacy</Text>

      {options.map((option) => (
        <View key={option.key}>
          <Text style={styles.sectionLabel}>{option.section}</Text>
          <Text style={styles.sectionBody}>{option.description}</Text>

          <View
            style={styles.row}
            accessible
            accessibilityLabel={`${option.title}: ${option.statusLabel}`}
            accessibilityState={{ disabled: !option.toggleable }}
          >
            <View style={styles.rowCopy}>
              <Text style={styles.rowLabel}>{option.title}</Text>
              <Text style={styles.rowDetail}>{option.statusDetail}</Text>
            </View>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{option.statusLabel}</Text>
            </View>
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: {
      backgroundColor: colors.background,
      flex: 1,
    },
    content: {
      gap: 8,
      padding: 24,
      paddingBottom: 48,
    },
    title: {
      color: colors.textStrong,
      fontSize: 28,
      fontWeight: '700',
      marginBottom: 8,
    },
    sectionLabel: {
      color: colors.textFaint,
      fontSize: 12,
      letterSpacing: 1,
      marginBottom: 8,
      marginTop: 20,
    },
    sectionBody: {
      color: colors.textSecondary,
      fontSize: 13,
      lineHeight: 20,
    },
    row: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: 1,
      flexDirection: 'row',
      gap: 16,
      marginTop: 12,
      padding: 16,
    },
    rowCopy: {
      flex: 1,
      gap: 4,
    },
    rowLabel: {
      color: colors.textPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
    rowDetail: {
      color: colors.textMuted,
      fontSize: 13,
      lineHeight: 18,
    },
    badge: {
      borderColor: colors.border,
      borderRadius: 999,
      borderWidth: 1,
      maxWidth: 130,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    badgeText: {
      color: colors.textMuted,
      fontSize: 11,
      fontWeight: '600',
      textAlign: 'center',
    },
  });
