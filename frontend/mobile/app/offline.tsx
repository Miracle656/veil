import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useConnectivity } from '../lib/connectivity';

/**
 * Offline screen. Ported from `frontend/wallet/app/offline/page.tsx`, with the
 * outbox summary added so the user can see that the actions they took while
 * offline are queued rather than lost.
 */
export default function OfflineScreen() {
  const { connectionType, pendingActions, refresh } = useConnectivity();
  const [isRetrying, setIsRetrying] = useState(false);

  const handleRetry = async () => {
    setIsRetrying(true);
    try {
      await refresh();
    } finally {
      setIsRetrying(false);
    }
  };

  const queued = pendingActions.length;

  return (
    <View style={styles.container}>
      <NoSignalGlyph />

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
        accessibilityRole="button"
        accessibilityState={{ disabled: isRetrying }}
        disabled={isRetrying}
        onPress={handleRetry}
        style={({ pressed }) => [styles.retry, pressed && styles.retryPressed]}
      >
        <Text style={styles.retryLabel}>{isRetrying ? 'Checking...' : 'Try again'}</Text>
      </Pressable>

      <Text style={styles.meta}>Connection: {connectionType}</Text>
    </View>
  );
}

/**
 * A struck-through signal indicator, built from plain views so the screen needs
 * no SVG or icon-font dependency to render while the device is offline.
 */
function NoSignalGlyph() {
  return (
    <View accessible accessibilityLabel="No network connection" style={styles.glyph}>
      <View style={[styles.arc, styles.arcLarge]} />
      <View style={[styles.arc, styles.arcMedium]} />
      <View style={[styles.arc, styles.arcSmall]} />
      <View style={styles.arcDot} />
      <View style={styles.slash} />
    </View>
  );
}

const MUTED = '#D6D2C4';
const OFF_WHITE = '#F6F7F8';
const GOLD = '#FDDA24';

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0F0F0F',
    paddingHorizontal: 24,
    gap: 16,
  },
  glyph: {
    width: 96,
    height: 96,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 18,
    gap: 8,
  },
  arc: {
    height: 5,
    borderRadius: 999,
    backgroundColor: MUTED,
    opacity: 0.75,
  },
  arcLarge: {
    width: 64,
  },
  arcMedium: {
    width: 44,
  },
  arcSmall: {
    width: 24,
  },
  arcDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: MUTED,
    opacity: 0.75,
  },
  slash: {
    position: 'absolute',
    top: 52,
    width: 104,
    height: 3,
    borderRadius: 999,
    backgroundColor: MUTED,
    transform: [{ rotate: '45deg' }],
  },
  title: {
    color: OFF_WHITE,
    fontSize: 24,
    fontWeight: '600',
    fontStyle: 'italic',
    fontFamily: Platform.select({ ios: 'Georgia', default: 'serif' }),
    textAlign: 'center',
  },
  body: {
    color: 'rgba(246,247,248,0.5)',
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
    borderColor: 'rgba(253,218,36,0.28)',
    backgroundColor: 'rgba(253,218,36,0.08)',
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 4,
  },
  queueCount: {
    color: GOLD,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  queueHint: {
    color: 'rgba(246,247,248,0.6)',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  retry: {
    marginTop: 8,
    borderRadius: 999,
    backgroundColor: GOLD,
    paddingVertical: 12,
    paddingHorizontal: 28,
  },
  retryPressed: {
    opacity: 0.75,
  },
  retryLabel: {
    color: '#0F0F0F',
    fontSize: 15,
    fontWeight: '700',
  },
  meta: {
    color: 'rgba(246,247,248,0.35)',
    fontSize: 12,
  },
});
