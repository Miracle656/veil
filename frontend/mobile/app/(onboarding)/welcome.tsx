import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants, { ExecutionEnvironment } from 'expo-constants';

import { useTheme } from '../../hooks/useTheme';
import type { ThemeColors } from '../../lib/theme';
import { fontFamily } from '../../theme/typography';
import { VeilLogo } from '../../components/VeilLogo';
import { setWalletAddress } from '../../lib/walletStore';

const SEEN_WELCOME_KEY = 'veil_seen_welcome';

// In the dev build (not Expo Go) the create screen leads with the passkey flow.
// What the wallet does today, under the headline's three claims: agentic,
// passkey, Stellar. Deliberately names no single currency — Veil targets
// African markets broadly, not one country.
const WALLET_NOTES = [
  'Send and receive USDC — settles in seconds',
  'Swap and earn without leaving the wallet',
  'Ask the agent; approve with your fingerprint',
  'Balances in your local currency',
];

const IN_EXPO_GO = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

/**
 * Landing / onboarding entry — the design's "4b" screen.
 *
 * A full-bleed statement of the product ("Spend naira. Earn dollars. No keys.")
 * over the Veil brand, with one primary action (create) and recovery beneath.
 * Redirects straight to the dashboard once a wallet exists.
 */
export default function Welcome() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [ready, setReady] = useState(false);

  // The index route already redirects when a wallet exists, so the landing just
  // renders. A one-tick gate avoids a fonts-not-ready flash on cold start.
  useEffect(() => {
    setReady(true);
  }, []);

  const handleCreate = async () => {
    await AsyncStorage.setItem(SEEN_WELCOME_KEY, '1');
    router.push('/create-wallet');
  };

  const handleRecover = async () => {
    await AsyncStorage.setItem(SEEN_WELCOME_KEY, '1');
    router.push('/login');
  };

  // Dev-only: seed a wallet address so the router lets us into the app, to
  // iterate on the post-login UI (dashboard, send, etc.) without a real passkey /
  // dev build. Gated on __DEV__, so it never ships in a release build.
  const handleDevPreview = async () => {
    await setWalletAddress('CCRVWU6JPRKWWC2H6U6IWQ6EECN5K54W2QA243RYFN2PAZVMJFYMITSK');
    router.replace('/dashboard');
  };

  if (!ready) return <View style={styles.screen} />;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="welcome-screen">
      <View style={styles.body}>
        {/* Header — brand + network */}
        <View style={styles.headerRow}>
          <View style={styles.brand}>
            <VeilLogo size={26} color={colors.accent} />
            <Text style={styles.wordmark}>VEIL</Text>
          </View>
          <Text style={styles.network}>SOROBAN · TESTNET</Text>
        </View>

        {/* Statement. Anton uppercase, as before — only the wording changed. */}
        <Text style={styles.statement}>
          The agentic{'\n'}passkey wallet{'\n'}
          <Text style={styles.statementGold}>for Stellar.</Text>
        </Text>

        <View style={styles.notes}>
          {WALLET_NOTES.map((note) => (
            <View key={note} style={styles.note}>
              <View style={styles.noteDot} />
              <Text style={styles.noteText}>{note}</Text>
            </View>
          ))}
        </View>

        <View style={styles.spacer} />

        <Pressable
          onPress={handleCreate}
          accessibilityRole="button"
          style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
          testID="welcome-create"
        >
          <Text style={styles.primaryLabel}>
            {IN_EXPO_GO ? 'Create testnet wallet' : 'Create wallet with a passkey'}
          </Text>
        </Pressable>
        <Pressable
          onPress={handleRecover}
          accessibilityRole="button"
          style={({ pressed }) => [styles.recoverBtn, pressed && styles.pressed]}
        >
          <Text style={styles.recoverLabel}>I already have a wallet</Text>
        </Pressable>

        {__DEV__ && (
          <Pressable
            onPress={handleDevPreview}
            accessibilityRole="button"
            style={({ pressed }) => [styles.devBtn, pressed && styles.pressed]}
          >
            <Text style={styles.devLabel}>Preview dashboard (dev)</Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: colors.background,
    },
    body: {
      flex: 1,
      paddingHorizontal: 28,
      paddingTop: 24,
      paddingBottom: 32,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    brand: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    wordmark: {
      fontFamily: fontFamily.accent,
      fontSize: 19,
      letterSpacing: 1.5,
      color: colors.accent,
    },
    network: {
      fontFamily: fontFamily.address,
      fontSize: 11,
      letterSpacing: 1.3,
      color: colors.textFaint,
    },
    motifRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      marginTop: 40,
      height: 44,
    },
    ticker: {
      fontFamily: fontFamily.address,
      fontSize: 10,
      letterSpacing: 1.3,
      color: colors.textFaint,
      width: 150,
    },
    motifDivider: {
      width: 1,
      height: 44,
      backgroundColor: colors.border,
    },
    bars: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 3,
      height: 44,
    },
    bar: {
      width: 3,
      borderRadius: 1,
      backgroundColor: colors.accent,
    },
    statement: {
      fontFamily: fontFamily.accent,
      fontSize: 44,
      lineHeight: 47,
      letterSpacing: 0.5,
      textTransform: 'uppercase',
      color: colors.textPrimary,
      marginTop: 24,
    },
    statementGold: {
      color: colors.accent,
    },
    notes: {
      borderTopWidth: 1,
      borderTopColor: colors.border,
      marginTop: 26,
      paddingTop: 16,
    },
    note: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      marginBottom: 10,
    },
    noteDot: {
      width: 5,
      height: 5,
      borderRadius: 999,
      backgroundColor: colors.accent,
      marginTop: 6,
      marginRight: 10,
    },
    noteText: {
      flex: 1,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 18,
      color: colors.textSecondary,
    },
    spacer: {
      flex: 1,
    },
    primaryBtn: {
      backgroundColor: colors.accent,
      borderRadius: 999,
      paddingVertical: 17,
      alignItems: 'center',
    },
    primaryLabel: {
      color: colors.onAccent,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
    },
    recoverBtn: {
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: 4,
    },
    recoverLabel: {
      color: colors.textSecondary,
      fontFamily: fontFamily.bodyMedium,
      fontSize: 14,
    },
    pressed: {
      opacity: 0.7,
    },
    devBtn: {
      alignSelf: 'center',
      marginTop: 10,
      paddingVertical: 8,
      paddingHorizontal: 16,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border,
      borderStyle: 'dashed',
    },
    devLabel: {
      color: colors.textFaint,
      fontFamily: fontFamily.address,
      fontSize: 12,
    },
  });
