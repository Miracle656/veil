import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import type { HeldAsset } from '../lib/assets';
import { truncateAddress } from './ui/AddressChip';

/**
 * One row of the portfolio list — a held asset's code, issuer, and balance.
 * Presentational: it reads the theme for colours but takes the asset as data,
 * so the list can render many without re-fetching anything.
 */
export function AssetRow({ asset }: { asset: HeldAsset }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={styles.row}>
      <View style={styles.left}>
        <Text style={styles.code}>{asset.code}</Text>
        <Text style={styles.issuer} numberOfLines={1}>
          {truncateAddress(asset.issuer, 6, 6)}
        </Text>
      </View>
      <Text style={styles.balance}>{asset.balance}</Text>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      backgroundColor: colors.surface,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 14,
    },
    left: {
      flexShrink: 1,
      gap: 2,
    },
    code: {
      color: colors.textStrong,
      fontSize: 15,
      fontWeight: '600',
    },
    issuer: {
      color: colors.textMuted,
      fontSize: 12,
      fontFamily: 'monospace',
    },
    balance: {
      color: colors.textPrimary,
      fontSize: 15,
      fontWeight: '600',
      textAlign: 'right',
    },
  });
