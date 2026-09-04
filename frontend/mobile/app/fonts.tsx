import type { ReactNode } from "react";
import type { TextStyle } from "react-native";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { typography } from "../theme/typography";

/** A labelled specimen block for one typographic role. */
function Specimen({
  role,
  hint,
  style,
  children,
}: {
  role: string;
  hint: string;
  style: TextStyle;
  children: ReactNode;
}) {
  return (
    <View style={styles.block}>
      <Text style={styles.roleLabel}>{role}</Text>
      <Text style={[styles.sample, style]}>{children}</Text>
      <Text style={styles.hint}>{hint}</Text>
    </View>
  );
}

/**
 * Type specimen screen (`/fonts`) — renders all four brand roles so the font
 * loading in `app/_layout.tsx` can be verified visually: no flash of system
 * font, and each role uses the correct face.
 */
export default function FontSpecimen() {
  return (
    <ScrollView showsVerticalScrollIndicator={false} style={styles.screen} contentContainerStyle={styles.container}>
      <Text style={styles.pageTitle}>Type specimen</Text>

      <Specimen role="Headings" hint="Lora · 600 · italic" style={typography.heading}>
        Send value, quietly.
      </Specimen>

      <Specimen role="Accent caps" hint="Anton · letterSpacing 0.08em" style={typography.accent}>
        Available balance
      </Specimen>

      <Specimen role="Body" hint="Inter" style={typography.body}>
        Veil is a passkey-native Stellar wallet. This paragraph is set in Inter, the body
        face shared with the web wallet for cross-platform parity.
      </Specimen>

      <Specimen role="Addresses & hashes" hint="Inconsolata" style={typography.address}>
        GA3D…K9FQ · 3f9a1c…b27e
      </Specimen>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#0B0B0F",
  },
  container: {
    padding: 24,
    gap: 28,
  },
  pageTitle: {
    color: "#FFFFFF",
    fontFamily: typography.accent.fontFamily,
    fontSize: 13,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  block: {
    gap: 6,
  },
  roleLabel: {
    color: "#9BA1A6",
    fontSize: 12,
  },
  sample: {
    color: "#FFFFFF",
  },
  hint: {
    color: "#6B7280",
    fontSize: 12,
  },
});
