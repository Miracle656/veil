import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../hooks/useTheme';
import { useConnectivity } from '../lib/connectivity';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';

/**
 * Offline screen. Ported from `frontend/wallet/app/offline/page.tsx`, with the
 * outbox summary added so the user can see that the actions they took while
 * offline are queued rather than lost.
 *
 * Themed from `useTheme`. It hard-coded the dark palette, so in light mode it
 * was the one near-black screen in the app.
 *
 * It must never be a dead end. "Try again" leaves as soon as the check comes
 * back online, and "Continue anyway" always leaves: a connection check can be
 * wrong (a network that blocks the probe but reaches Stellar fine), and the
 * user is the better judge of whether their wallet loads.
 */
export default function OfflineScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { connectionType, pendingActions, refresh } = useConnectivity();
  const [isRetrying, setIsRetrying] = useState(false);
  const [stillOffline, setStillOffline] = useState(false);

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const handleRetry = async () => {
    setIsRetrying(true);
    setStillOffline(false);
    try {
      const online = await refresh();
      if (online) leave();
      else setStillOffline(true);
    } finally {
      setIsRetrying(false);
    }
  };

  const queued = pendingActions.length;

  return (
    <View style={styles.container} testID="offline-screen">
      <NoSignalGlyph color={colors.textMuted} />

      <Text style={styles.title}>You&apos;re offline</Text>
      <Text style={styles.body}>
        Check your connection and try again. Your wallet data is safe.
      </Text>

      {queued > 0 && (
        <View style={styles.queueCard}>
          <Text style={styles.queueCount}>
            {queued} {queued === 1 ? 'action' : 'actions'} queued
          </Text>
          <Text style={styles.queueHint}>
            They will run automatically as soon as you are back online.
          </Text>
        </View>
      )}

      <Pressable
        testID="offline-retry-button"
        accessibilityRole="button"
        accessibilityState={{ disabled: isRetrying }}
        disabled={isRetrying}
        onPress={handleRetry}
        style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
      >
        <Text style={styles.retryLabel}>{isRetrying ? 'Checking...' : 'Try again'}</Text>
      </Pressable>

      {stillOffline && (
        <Text style={styles.hint}>Still can&apos;t reach the network.</Text>
      )}

      <Pressable
        testID="offline-continue-button"
        accessibilityRole="button"
        onPress={leave}
        style={({ pressed }) => [styles.continue, pressed && styles.pressed]}
      >
        <Text style={styles.continueLabel}>Continue anyway</Text>
      </Pressable>

      <Text style={styles.meta}>Connection: {connectionType}</Text>
    </View>
  );
}

/**
 * A struck-through signal indicator, built from plain views so the screen needs
 * no SVG or icon-font dependency to render while the device is offline.
 */
function NoSignalGlyph({ color }: { color: string }) {
  return (
    <View accessible accessibilityLabel="No network connection" style={glyph.box}>
      <View style={[glyph.arc, glyph.arcLarge, { backgroundColor: color }]} />
      <View style={[glyph.arc, glyph.arcMedium, { backgroundColor: color }]} />
      <View style={[glyph.arc, glyph.arcSmall, { backgroundColor: color }]} />
      <View style={[glyph.arcDot, { backgroundColor: color }]} />
      <View style={[glyph.slash, { backgroundColor: color }]} />
    </View>
  );
}

const glyph = StyleSheet.create({
  box: {
    width: 96,
    height: 96,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 18,
    gap: 8,
  },
  arc: { height: 5, borderRadius: 999, opacity: 0.75 },
  arcLarge: { width: 64 },
  arcMedium: { width: 44 },
  arcSmall: { width: 24 },
  arcDot: { width: 8, height: 8, borderRadius: 999, opacity: 0.75 },
  slash: {
    position: 'absolute',
    top: 52,
    width: 104,
    height: 3,
    borderRadius: 999,
    transform: [{ rotate: '45deg' }],
  },
});

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.background,
      paddingHorizontal: 24,
      gap: 16,
    },
    title: {
      color: colors.textStrong,
      fontFamily: fontFamily.heading,
      fontSize: 26,
      textAlign: 'center',
    },
    body: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 14,
      lineHeight: 22,
      maxWidth: 288,
      textAlign: 'center',
    },
    queueCard: {
      alignSelf: 'stretch',
      maxWidth: 320,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceMd,
      paddingVertical: 12,
      paddingHorizontal: 16,
      gap: 4,
    },
    queueCount: {
      color: colors.accentText,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 14,
      textAlign: 'center',
    },
    queueHint: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 12,
      lineHeight: 18,
      textAlign: 'center',
    },
    retry: {
      marginTop: 8,
      borderRadius: 999,
      backgroundColor: colors.accent,
      paddingVertical: 13,
      paddingHorizontal: 32,
    },
    retryLabel: {
      color: colors.onAccent,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
    },
    hint: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 13,
    },
    continue: {
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border,
      paddingVertical: 12,
      paddingHorizontal: 28,
    },
    continueLabel: {
      color: colors.textPrimary,
      fontFamily: fontFamily.bodyMedium,
      fontSize: 14,
    },
    pressed: { opacity: 0.7 },
    meta: {
      color: colors.textFaint,
      fontFamily: fontFamily.body,
      fontSize: 12,
    },
  });
