import { useMemo } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { useTheme } from '../hooks/useTheme';
import { useHiddenAmounts } from '../hooks/useHiddenAmounts';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';

type Choice = { key: string; label: string; detail: string };

export function SavedRecipients({
  choices,
  onPick,
  onRemove,
}: {
  choices: Choice[];
  onPick: (key: string) => void;
  onRemove: (key: string) => void;
}) {
  const { colors } = useTheme();
  const { hidden, isHydrated } = useHiddenAmounts();
  const styles = useMemo(() => createStyles(colors), [colors]);

  if (!isHydrated || hidden || choices.length === 0) return null;
  return (
    <View style={styles.group}>
      <Text style={styles.heading}>SAVED RECIPIENTS</Text>
      {choices.map((choice) => (
        <View key={choice.key} style={styles.row}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Use saved ${choice.label}`}
            onPress={() => onPick(choice.key)}
            style={styles.pick}
          >
            <Text style={styles.label}>{choice.label}</Text>
            <Text style={styles.detail}>{choice.detail}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Delete saved ${choice.label}`}
            onPress={() => onRemove(choice.key)}
            style={styles.remove}
          >
            <Text style={styles.removeText}>Delete</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

export function SaveRecipientSwitch({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.switchRow}>
      <Text style={styles.label}>Save for next time</Text>
      <Switch value={value} onValueChange={onChange} accessibilityLabel="Save for next time" />
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    group: { marginBottom: 24, gap: 8 },
    heading: {
      color: colors.textMuted,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 11,
      letterSpacing: 1,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 12,
    },
    pick: { flex: 1, padding: 12 },
    label: { color: colors.textStrong, fontFamily: fontFamily.bodySemiBold, fontSize: 14 },
    detail: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 12,
      marginTop: 3,
    },
    remove: { paddingHorizontal: 12, paddingVertical: 14 },
    removeText: { color: colors.textSecondary, fontFamily: fontFamily.bodySemiBold, fontSize: 12 },
    switchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 14,
    },
  });
}
