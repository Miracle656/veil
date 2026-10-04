import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { formatFundingXlm } from '../lib/fees';
import { fontFamily } from '../theme/typography';

export type FeePayerBannerProps = {
  /** Classic `G…` fee-payer address — never the `C…` wallet address. */
  feePayerAddress: string;
  /** `true` when Horizon has no account at all (404). */
  missing: boolean;
  /** What the account holds (0 when missing). */
  balance: number;
  /** Reserve + fee buffer: the concrete amount the banner names. */
  needed: number;
  /** `needed - balance`; 0 when healthy (banner is not rendered then). */
  shortfall: number;
  /** Hide the banner until the next funding state change. */
  onDismiss: () => void;
};

/**
 * Fee-payer funding banner (V193 / #766).
 *
 * A wallet recovered without PRF gets a fresh random fee-payer holding zero
 * XLM: the balance loads, the passkey signs, and then every submission fails
 * because a Soroban contract cannot pay its own gas. Failing at submission
 * time with a network error is the worst place to discover this, so the
 * dashboard names the gap up front — the concrete amount, the `G…` address
 * that needs it (with copy + QR), and one line saying this account pays
 * network fees and is not the wallet balance.
 */
export function FeePayerBanner({
  feePayerAddress,
  missing,
  balance,
  needed,
  shortfall,
  onDismiss,
}: FeePayerBannerProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await Clipboard.setStringAsync(feePayerAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  const headline = missing
    ? `This device's fee account needs ${formatFundingXlm(needed)} to activate`
    : `This device's fee account needs ${formatFundingXlm(shortfall)} more`;

  const subline = missing
    ? 'It does not exist on the network yet.'
    : `It holds ${formatFundingXlm(balance)} of the ${formatFundingXlm(needed)} required.`;

  return (
    <View style={styles.banner} testID="fee-payer-banner">
      <View style={styles.headerRow}>
        <Text style={styles.title}>Fee account needs funding</Text>
        <Pressable
          testID="fee-payer-banner-dismiss"
          accessibilityRole="button"
          accessibilityLabel="Dismiss fee funding banner"
          onPress={onDismiss}
          hitSlop={8}
          style={({ pressed }) => [styles.dismiss, pressed && styles.pressed]}
        >
          <Text style={styles.dismissText}>✕</Text>
        </Pressable>
      </View>

      <Text style={styles.headline}>{headline}</Text>
      <Text style={styles.subline}>{subline}</Text>

      <View style={styles.qrFrame}>
        <QRCode value={feePayerAddress} size={120} backgroundColor="#F6F7F8" color="#0F0F0F" />
      </View>

      <Pressable
        testID="fee-payer-banner-copy"
        accessibilityRole="button"
        accessibilityLabel={`Copy fee account address ${feePayerAddress}`}
        onPress={handleCopy}
        style={({ pressed }) => [styles.addressRow, pressed && styles.pressed]}
      >
        <Text testID="fee-payer-banner-address" style={styles.address} numberOfLines={1}>
          {feePayerAddress}
        </Text>
        <Text style={styles.copy}>{copied ? 'Copied' : 'Copy'}</Text>
      </Pressable>

      <Text style={styles.explainer}>
        This account pays network fees and is not your wallet balance.
      </Text>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    banner: {
      backgroundColor: colors.dangerSurface,
      borderWidth: 1,
      borderColor: colors.danger,
      borderRadius: 16,
      paddingHorizontal: 16,
      paddingVertical: 14,
      gap: 8,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    title: {
      color: colors.danger,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 11,
      letterSpacing: 1.4,
      textTransform: 'uppercase',
    },
    dismiss: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceMd,
    },
    dismissText: {
      color: colors.textSecondary,
      fontSize: 13,
      fontWeight: '700',
    },
    headline: {
      color: colors.textPrimary,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 14,
      lineHeight: 20,
    },
    subline: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
    },
    qrFrame: {
      alignSelf: 'center',
      backgroundColor: '#F6F7F8',
      borderRadius: 12,
      padding: 12,
      marginTop: 4,
    },
    addressRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: colors.surfaceMd,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    address: {
      flex: 1,
      color: colors.textPrimary,
      fontFamily: fontFamily.address,
      fontSize: 11,
    },
    copy: {
      color: colors.accentText,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 13,
      flexShrink: 0,
    },
    explainer: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 12.5,
      lineHeight: 18,
    },
    pressed: { opacity: 0.7 },
  });
