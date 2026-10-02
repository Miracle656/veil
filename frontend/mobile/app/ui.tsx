import { ScrollView, StyleSheet, Text, View } from "react-native";

import { AddressChip, Button, Card, Highlight, Screen } from "../components/ui";
import { colors } from "../theme/colors";
import { typography } from "../theme/typography";

const SAMPLE_ADDRESS = "GA3DHM4WL2VXPHR7NQKPZ7XK9FQJ2ULTQ6ZT4W2M5N6Q7RSTUVWXK9FQ";

/**
 * Primitives gallery (`/ui`) — renders every shared UI primitive so the port
 * can be checked side-by-side against the web wallet.
 */
export default function UiGallery() {
  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={[typography.heading, styles.title]}>UI primitives</Text>

        <Text style={styles.sectionLabel}>Card</Text>
        <Card>
          <Text style={styles.cardHeading}>Default card</Text>
          <Text style={styles.body}>The base surface panel every screen composes from.</Text>
        </Card>
        <Card variant="md">
          <Text style={styles.cardHeading}>Raised card (md)</Text>
          <Text style={styles.body}>Brighter surface for nested or emphasised content.</Text>
        </Card>

        <Text style={styles.sectionLabel}>Highlight</Text>
        <Highlight textStyle={styles.highlightText}>Send value, quietly</Highlight>

        <Text style={styles.sectionLabel}>Buttons</Text>
        <View style={styles.row}>
          <Button label="Send" variant="gold" fullWidth={false} style={styles.flex} />
          <Button label="Cancel" variant="ghost" fullWidth={false} style={styles.flex} />
        </View>
        <Button label="Disabled" variant="gold" disabled />

        <Text style={styles.sectionLabel}>Address chip</Text>
        <AddressChip address={SAMPLE_ADDRESS} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: 16,
    paddingVertical: 24,
  },
  title: {
    color: colors.offWhite,
  },
  sectionLabel: {
    color: colors.textMuted,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: 12,
  },
  cardHeading: {
    color: colors.offWhite,
    fontFamily: typography.body.fontFamily,
    fontSize: 16,
    marginBottom: 6,
  },
  body: {
    color: colors.textMuted,
    fontFamily: typography.body.fontFamily,
    fontSize: 15,
    lineHeight: 22,
  },
  highlightText: {
    fontFamily: typography.heading.fontFamily,
    fontSize: 22,
  },
  row: {
    flexDirection: "row",
    gap: 12,
  },
  flex: {
    flex: 1,
  },
});
