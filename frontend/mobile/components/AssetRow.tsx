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
export function AssetRow({
  asset,
  usdValueFormatted,
}: {
  asset: HeldAsset;
  usdValueFormatted?: string;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={styles.row}>
      <View style={styles.left}>
        <Text style={styles.code}>
          {asset.code}
          {asset.name ? <Text style={styles.assetName}> · {asset.name}</Text> : null}
        </Text>
        <Text style={styles.issuer} numberOfLines={1}>
          {truncateAddress(asset.issuer, 6, 6)}
        </Text>
      </View>
      <View style={styles.right}>
        <Text style={styles.balance}>{asset.balance}</Text>
        {usdValueFormatted ? <Text style={styles.fiat}>{usdValueFormatted}</Text> : null}
      </View>
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
    assetName: {
      color: colors.textMuted,
      fontSize: 13,
      fontWeight: '400',
    },
    issuer: {
      color: colors.textMuted,
      fontSize: 12,
      fontFamily: 'monospace',
    },
    right: {
      alignItems: 'flex-end',
      gap: 2,
    },
    balance: {
      color: colors.textPrimary,
      fontSize: 15,
      fontWeight: '600',
      textAlign: 'right',
    },
    fiat: {
      color: colors.textSecondary,
      fontSize: 13,
      fontWeight: '500',
      textAlign: 'right',
    },
  });
