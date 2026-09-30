import { useMemo } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { useTheme } from '../../hooks/useTheme';
import { getNetworkName } from '../../lib/network';
import { getPrivacyOptions, type PrivacyOption } from '../../lib/privacySettings';
import type { ThemeColors } from '../../lib/theme';

export default function PrivacySettingsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const network = getNetworkName();
  const options = useMemo(() => getPrivacyOptions(network), [network]);

  return (
    <ScrollView showsVerticalScrollIndicator={false} style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Privacy</Text>
      <Text style={styles.subtitle}>
        Control telemetry and review zero-knowledge transaction protections.
      </Text>

      {options.map((opt) => (
        <View key={opt.key} style={styles.section}>
          <Text style={styles.sectionLabel}>{opt.category}</Text>
          <Text style={styles.sectionBody}>{opt.description}</Text>

          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <View style={styles.cardCopy}>
                <Text style={styles.cardTitle}>{opt.title}</Text>
                <Text style={[styles.statusBadge, !opt.available && styles.statusBadgeMuted]}>
                  {opt.statusLabel}
                </Text>
              </View>

              <Switch
                value={opt.available}
                disabled={!opt.toggleable}
                trackColor={{ false: colors.border, true: colors.accent }}
                thumbColor={colors.surface}
                accessibilityLabel={`${opt.title} toggle`}
              />
            </View>

            {opt.unavailableReason ? (
              <Text style={styles.unavailableText}>{opt.unavailableReason}</Text>
            ) : null}
          </View>
        </View>
      ))}

      <Text style={styles.footerNote}>
        Veil never logs secret keys, balances, or transaction recipients to external services.
      </Text>
    </ScrollView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    screen: {
      backgroundColor: colors.background,
      flex: 1,
    },
    content: {
      gap: 20,
      padding: 24,
      paddingBottom: 48,
    },
    title: {
      color: colors.textPrimary,
      fontFamily: 'Lora-BoldItalic',
      fontSize: 28,
    },
    subtitle: {
      color: colors.textMuted,
      fontSize: 14,
      lineHeight: 20,
      marginTop: -12,
    },
    section: {
      gap: 8,
      marginTop: 8,
    },
    sectionLabel: {
      color: colors.textMuted,
      fontFamily: 'Inconsolata-Bold',
      fontSize: 12,
      letterSpacing: 1.5,
    },
    sectionBody: {
      color: colors.textMuted,
      fontSize: 13,
      lineHeight: 18,
    },
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: 1,
      gap: 12,
      padding: 16,
    },
    cardHeader: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    cardCopy: {
      flex: 1,
      gap: 4,
    },
    cardTitle: {
      color: colors.textPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
    statusBadge: {
      color: colors.accentText,
      fontSize: 12,
      fontWeight: '500',
    },
    statusBadgeMuted: {
      color: colors.textMuted,
    },
    unavailableText: {
      color: colors.textSecondary,
      fontSize: 12,
      lineHeight: 16,
    },
    footerNote: {
      color: colors.textMuted,
      fontSize: 12,
      lineHeight: 18,
      marginTop: 16,
      textAlign: 'center',
    },
  });
}
