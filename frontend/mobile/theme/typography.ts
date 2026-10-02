import type { TextStyle } from "react-native";

import { Lora_600SemiBold_Italic } from "@expo-google-fonts/lora";
import { Anton_400Regular } from "@expo-google-fonts/anton";
import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold } from "@expo-google-fonts/inter";
import { Inconsolata_400Regular } from "@expo-google-fonts/inconsolata";

/**
 * Brand typefaces, loaded once at startup by `app/_layout.tsx` via `useFonts`.
 * The keys here are the family names referenced by `fontFamily` below, so the
 * loaded font and the style token can never drift apart.
 */
export const fontAssets = {
  Lora_600SemiBold_Italic,
  Anton_400Regular,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inconsolata_400Regular,
};

/**
 * Family name per role — mirrors how the Veil web wallet (`frontend/wallet`)
 * uses each face, keeping typographic parity across platforms.
 */
export const fontFamily = {
  heading: "Lora_600SemiBold_Italic",
  accent: "Anton_400Regular",
  body: "Inter_400Regular",
  bodyMedium: "Inter_500Medium",
  bodySemiBold: "Inter_600SemiBold",
  address: "Inconsolata_400Regular",
} as const;

/**
 * Role-based text styles matching the web wallet's usage:
 *   heading → Lora 600 italic  (wallet renders h2 as Lora, weight 600, italic)
 *   accent  → Anton caps, letterSpacing 0.08em
 *   body    → Inter
 *   address → Inconsolata (addresses / hashes)
 *
 * Note: React Native `letterSpacing` is in points, not em — 0.08em at the 13pt
 * accent size is ≈ 1pt.
 */
export const typography = {
  heading: {
    fontFamily: fontFamily.heading,
    fontSize: 28,
    lineHeight: 34,
  },
  accent: {
    fontFamily: fontFamily.accent,
    fontSize: 13,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  body: {
    fontFamily: fontFamily.body,
    fontSize: 16,
    lineHeight: 24,
  },
  address: {
    fontFamily: fontFamily.address,
    fontSize: 14,
  },
} satisfies Record<string, TextStyle>;
