import { useMemo, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { bankInitials, bankLogoUrl, type NigerianBank } from '../lib/nigerianBanks';

/**
 * A bank's mark in the payout picker — its logo, or its initial.
 *
 * The logo is remote (nigerianbanks.xyz), which means it can be slow, missing,
 * or unreachable on the mobile connection this screen is most often used on. So
 * the lettered disc is not a placeholder that gets replaced; it is what the row
 * renders, with the image drawn over it once it has loaded. A row never
 * collapses, never shifts, and never shows a broken-image glyph.
 *
 * It is decoration. The thing that moves money is the payout code beside it,
 * and the account name the bank itself returns — see the note in
 * `lib/nigerianBanks.ts` about why the logo slug is a separate identifier.
 */
export function BankMark({
  bank,
  size = 32,
}: {
  bank: Pick<NigerianBank, 'name' | 'slug' | 'short' | 'badge'>;
  size?: number;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [failed, setFailed] = useState(false);

  const uri = bankLogoUrl(bank.slug);
  const initial = bankInitials(bank);

  return (
    <View
      style={[styles.disc, { width: size, height: size, borderRadius: size / 2 }]}
      accessible={false}
    >
      <Text style={[styles.initial, { fontSize: size * (initial.length > 1 ? 0.34 : 0.42) }]}>{initial}</Text>
      {uri && !failed ? (
        <Image
          source={{ uri }}
          onError={() => setFailed(true)}
          resizeMode="contain"
          style={[
            StyleSheet.absoluteFill,
            { width: size, height: size, borderRadius: size / 2 },
          ]}
        />
      ) : null}
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    disc: {
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
      flexShrink: 0,
      backgroundColor: colors.surfaceMd,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    initial: {
      color: colors.textMuted,
      fontFamily: fontFamily.bodySemiBold,
    },
  });
