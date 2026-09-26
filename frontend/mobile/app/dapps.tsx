import { useMemo } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';

import { DAPP_DIRECTORY, isAllowedDappOrigin } from '../../shared/dapps';
import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';

/**
 * Discover dApps — mobile's half of web parity (#813).
 *
 * Both apps render the same curated allow-list from
 * `frontend/shared/dapps.ts`, so an entry added there appears here and in the
 * web wallet's `/dapps` directory at the same time. Discovery, not embedding:
 * entries are handed to the system browser, and the user connects back through
 * the existing WalletConnect approval flow. No WebView lives on this screen.
 */
export default function DappsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const openDapp = async (origin: string, name: string) => {
    // Defence in depth: the directory is curated, but this screen will still
    // refuse anything that is not on the shared allow-list — including an
    // http:// origin or a look-alike host.
    if (!isAllowedDappOrigin(origin)) {
      Alert.alert('Not allow-listed', `${origin} is not on Veil's curated dApp directory.`);
      return;
    }
    try {
      await WebBrowser.openBrowserAsync(origin);
    } catch {
      Alert.alert('Could not open', `Your browser could not open ${origin}.`);
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>Discover dApps</Text>
        <Text style={styles.subtitle}>
          The same curated directory the web wallet shows. Each dApp opens in your
          browser — never inside the wallet — and you connect back through
          WalletConnect.
        </Text>

        <View style={styles.list}>
          {DAPP_DIRECTORY.map((dapp) => (
            <Pressable
              key={dapp.id}
              style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
              onPress={() => void openDapp(dapp.origin, dapp.name)}
              accessibilityRole="link"
              accessibilityLabel={`Open ${dapp.name} in your browser`}
            >
              <View style={styles.cardHeader}>
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{dapp.name.slice(0, 1)}</Text>
                </View>
                <View style={styles.cardTitles}>
                  <Text style={styles.name}>{dapp.name}</Text>
                  <Text style={styles.origin}>{dapp.origin}</Text>
                </View>
                <Text style={styles.openLabel}>Open</Text>
              </View>
              <Text style={styles.description}>{dapp.description}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.note}>
          The directory is curated. Veil never signs inside a dApp — every request
          comes back to the wallet for your approval.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    content: { padding: 20, paddingBottom: 48, gap: 14 },
    title: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 28, marginTop: 4 },
    subtitle: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 14,
      lineHeight: 21,
    },
    list: { gap: 12, marginTop: 4 },
    card: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 16,
      padding: 16,
      gap: 10,
    },
    cardPressed: { opacity: 0.7 },
    cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    badge: {
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: colors.surfaceMd,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    badgeText: { color: colors.accent, fontFamily: fontFamily.bodySemiBold, fontSize: 16 },
    cardTitles: { flex: 1 },
    name: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 17 },
    origin: {
      color: colors.textFaint,
      fontFamily: fontFamily.address,
      fontSize: 12,
      marginTop: 2,
    },
    openLabel: { color: colors.accent, fontFamily: fontFamily.bodySemiBold, fontSize: 13 },
    description: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
    },
    note: {
      color: colors.textFaint,
      fontFamily: fontFamily.body,
      fontSize: 12,
      lineHeight: 18,
      marginTop: 8,
    },
  });
