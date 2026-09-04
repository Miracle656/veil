import { useState } from "react";
import { Pressable, StyleSheet, Text, type ViewStyle } from "react-native";
import * as Clipboard from "expo-clipboard";

import { colors } from "../../theme/colors";
import { fontFamily } from "../../theme/typography";

type AddressChipProps = {
  /** Full value copied to the clipboard on press. */
  address: string;
  /** Display text; defaults to a middle-truncated form of `address`. */
  label?: string;
  onCopy?: (address: string) => void;
  style?: ViewStyle;
};

/** `GABC…WXYZ` — middle-truncate a Stellar address for compact display. */
export function truncateAddress(address: string, lead = 4, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/**
 * Monospace address pill with tap-to-copy — the native equivalent of the web
 * wallet's `.address-chip` (globals.css): gold-tinted pill, Inconsolata text.
 * Shows a brief "Copied" confirmation after copying.
 */
export function AddressChip({ address, label, onCopy, style }: AddressChipProps) {
  const [copied, setCopied] = useState(false);

  async function handlePress() {
    await Clipboard.setStringAsync(address);
    onCopy?.(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Copy address ${address}`}
      onPress={handlePress}
      style={[styles.chip, style]}
    >
      <Text style={styles.text}>{copied ? "Copied" : (label ?? truncateAddress(address))}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 100,
    backgroundColor: colors.goldSoft,
    borderWidth: 1,
    borderColor: colors.goldBorder,
  },
  text: {
    fontFamily: fontFamily.address,
    fontSize: 13,
    letterSpacing: 0.13,
    color: colors.gold,
  },
});
