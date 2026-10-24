import { useEffect, useState } from 'react';
import { AppState, type AppStatus, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { listUnconfirmed, type UnconfirmedAction } from '../../lib/unconfirmed';

/**
 * The offline screen is a considered state at the app level. It
 * also surfaces any unconfirmed money actions so the user knows that
 * a payment may have gone through and that we will resolve it on
 * reconnect.
 */
export default function OfflineScreen() {
  const [appState, setAppState] = useState<AppStatus>(AppState.active);
  const [unconfirmed, setUnconfirmed] = useState<UnconfirmedAction[]>([]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', setAppState);
    return () => sub.remove();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listUnconfirmed().then(items => {
      if (!cancelled) setUnconfirmed(items);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const isOffline = appState !== AppState.active;

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <View style={styles.panel}>
        <Text style={styles.eyebrow}>Offline</Text>
        <Text style={styles.lede}>
          {isOffline
            ? 'You are offline. New payments are paused until you reconnect.'
            : 'You are back online.'}
        </Text>

        {unconfirmed.length > 0 ? (
          <View style={styles.warning}>
            <Text style={styles.warningTitle}>Unconfirmed actions</Text>
            <Text style={styles.warningBody}>
              You may already have been charged for these. We will resolve them as soon as you reconnect.
            </Text>
            {unconfirmed.map(item => (
              <Text key={item.id} style={styles.item}>
                {item.summary}
              </Text>
            ))}
          </View>
        ) : null}

        <Pressable style={styles.button} onPress={() => {/* navigation handled by the tab bar */}}>
          <Text style={styles.buttonText}>Retry when online</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, padding: 24, gap: 12 },
  eyebrow: { color: '#94a3b8', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 },
  lede: { color: '#e2e8f0', fontSize: 16 },
  warning: { backgroundColor: '#3b2f10', borderColor: '#f59e0b', borderWidth: 1, borderRadius: 10, padding: 12, gap: 6 },
  warningTitle: { color: '#f59e0b', fontWeight: '700' },
  warningBody: { color: '#fde470' },
  item: { color: '#e2e8f0', fontSize: 14 },
  button: { backgroundColor: '#6366f1', borderRadius: 10, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600' },
});
