import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import {
  formatAssetLabel,
  getRegisteredAsset,
  isRegisteredIssuer,
  verifiedAsset,
  type HeldAsset,
} from '../lib/assets';
import { getNetworkName } from '../lib/network';
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
  const registered = verifiedAsset(asset.code, asset.issuer, getNetworkName());
  const registeredCode = getRegisteredAsset(asset.code, getNetworkName());
  const impersonated = registeredCode &&
    asset.issuer !== registeredCode.issuer &&
    !isRegisteredIssuer(asset.code, asset.issuer, getNetworkName())
    ? registeredCode
    : null;

  return (
    <View style={styles.row}>
      <View style={styles.left}>
        <Text style={styles.code}>
          {formatAssetLabel(asset.code, asset.issuer, getNetworkName())}
          {asset.name ? <Text style={styles.assetName}> · {asset.name}</Text> : null}
        </Text>
        {/* As on the web assets page: a registered asset names its issuer,
            and anything else — including an impostor sharing a registered
            code — is marked unverified. */}
        {registered ? (
          <Text style={styles.verified}>Issuer: {registered.issuerName}</Text>
        ) : (
          <Text style={styles.unverified}>
            {impersonated ? `Impersonating ${impersonated.issuerName}` : 'Unverified asset'}
          </Text>
        )}
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
    verified: {
      color: colors.textSecondary,
      fontSize: 12,
    },
    unverified: {
      alignSelf: 'flex-start',
      color: colors.danger,
      fontSize: 11,
      fontWeight: '600',
      marginVertical: 2,
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
