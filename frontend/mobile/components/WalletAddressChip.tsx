import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { getFeePayerAddress } from '../lib/activity';
import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';

/**
 * The address in the dashboard header, which is two addresses.
 *
 * A Veil wallet is a contract account (`C…`), and that is the one that holds
 * the balance — but plenty of the ecosystem still cannot send to a contract,
 * and anyone funding the wallet from an exchange needs the classic `G…`
 * fee-payer instead. Showing only the C address left no way to reach the other
 * one, and no hint that it exists.
 *
 * So: tap the address to copy whichever is shown, and the button beside it
 * names the one you are not looking at — press "G" to switch to it. Naming the
 * destination rather than the current state is what makes a two-state toggle
 * legible without a legend.
 *
 * Colour comes from `accentText`, not `accent`: on light the fill gold
 * (#C4A800) is too pale to read at 13px, which is exactly why the theme
 * carries a separate darker token (#8A7600) for text.
 */
export function WalletAddressChip({ contractAddress }: { contractAddress: string }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [feePayer, setFeePayer] = useState<string | null>(null);
  const [showingG, setShowingG] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    getFeePayerAddress()
      .then((addr) => { if (alive) setFeePayer(addr); })
      .catch(() => { /* no G address available — the toggle just stays hidden */ });
    return () => { alive = false; };
  }, []);

  const shown = showingG && feePayer ? feePayer : contractAddress;
  const kind = showingG && feePayer ? 'G' : 'C';

  async function copy() {
    await Clipboard.setStringAsync(shown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={copy}
        accessibilityRole="button"
        accessibilityLabel={`Copy ${kind === 'G' ? 'classic' : 'contract'} address ${shown}`}
        hitSlop={6}
        style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
      >
        <Text style={styles.text} numberOfLines={1}>
          {copied ? 'Copied' : `${shown.slice(0, 6)}\u2026${shown.slice(-6)}`}
        </Text>
      </Pressable>

      {feePayer ? (
        <Pressable
          onPress={() => setShowingG((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={
            showingG ? 'Show contract address' : 'Show classic funding address'
          }
          hitSlop={8}
          style={({ pressed }) => [styles.toggle, pressed && styles.pressed]}
        >
          <Text style={styles.toggleText}>{showingG ? 'C' : 'G'}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    wrap: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    chip: {
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceMd,
      borderRadius: 999,
      paddingHorizontal: 14,
      paddingVertical: 5,
    },
    text: {
      fontFamily: fontFamily.address,
      fontSize: 13,
      color: colors.accentText,
    },
    toggle: {
      width: 26,
      height: 26,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceMd,
      alignItems: 'center',
      justifyContent: 'center',
    },
    toggleText: {
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 12,
      color: colors.accentText,
    },
    pressed: { opacity: 0.6 },
  });
