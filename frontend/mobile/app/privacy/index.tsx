import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Link, Stack } from 'expo-router';

import { Card, Screen } from '../../components/ui';
import { useTheme } from '../../hooks/useTheme';
import { fontFamily } from '../../theme/typography';

/**
 * The privacy section's landing screen.
 *
 * V131 gates the private-balance surfaces elsewhere; this screen is the
 * developer-facing entry into what exists so far — the V141 benchmark —
 * reached from Settings → Privacy. It grows as V142/V143 land (shield,
 * private send, unshield).
 */
export default function PrivacyIndexScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <Text style={styles.title}>Privacy</Text>
      <Text style={styles.body}>
        Shielded payments and the proving infrastructure behind them.
      </Text>

      <Link href="/privacy/benchmark" asChild>
        <Pressable accessibilityRole="button" style={({ pressed }) => [pressed && styles.pressed]}>
          <Card style={styles.card}>
            <Text style={styles.itemTitle}>Prover benchmark</Text>
            <Text style={styles.itemBody}>
              Time the V141 transaction through the native prover on this device.
            </Text>
          </Card>
        </Pressable>
      </Link>
    </Screen>
  );
}

const createStyles = (colors: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    title: {
      fontFamily: fontFamily.heading,
      fontSize: 28,
      lineHeight: 34,
      color: colors.textStrong,
    },
    body: {
      fontFamily: fontFamily.body,
      fontSize: 16,
      lineHeight: 24,
      color: colors.textSecondary,
      marginTop: 4,
    },
    card: {
      marginTop: 16,
    },
    itemTitle: {
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 16,
      color: colors.textStrong,
    },
    itemBody: {
      fontFamily: fontFamily.body,
      fontSize: 14,
      lineHeight: 20,
      color: colors.textSecondary,
      marginTop: 6,
    },
    pressed: {
      opacity: 0.85,
    },
  });
