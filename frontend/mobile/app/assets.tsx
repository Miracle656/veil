import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AssetRow } from '../components/AssetRow';
import { ThemeToggle } from '../components/ThemeToggle';
import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fetchHeldAssets, loadWalletAddress, type HeldAsset } from '../lib/assets';

type State =
  | { kind: 'loading' }
  | { kind: 'no-wallet' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; assets: HeldAsset[] };

export default function AssetsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const address = await loadWalletAddress();
      if (!address) {
        setState({ kind: 'no-wallet' });
        return;
      }
      const assets = await fetchHeldAssets(address);
      setState({ kind: 'ready', assets });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Assets</Text>
        <ThemeToggle />
      </View>
      <Text style={styles.subtitle}>Every asset your wallet holds beyond XLM.</Text>

      {state.kind === 'loading' && <ActivityIndicator color={colors.accent} style={styles.spinner} />}

      {state.kind === 'no-wallet' && (
        <Text style={styles.muted}>No wallet found on this device yet.</Text>
      )}

      {state.kind === 'error' && <Text style={styles.error}>{state.message}</Text>}

      {state.kind === 'ready' &&
        (state.assets.length === 0 ? (
          <Text style={styles.muted}>
            No assets beyond XLM. Add a trustline to hold other assets.
          </Text>
        ) : (
          <View style={styles.list}>
            {state.assets.map((asset) => (
              <AssetRow key={`${asset.code}-${asset.issuer}`} asset={asset} />
            ))}
          </View>
        ))}
    </ScrollView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      flexGrow: 1,
      backgroundColor: colors.background,
      padding: 24,
      gap: 16,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    title: {
      color: colors.textStrong,
      fontSize: 28,
      fontWeight: '700',
    },
    subtitle: {
      color: colors.textSecondary,
      fontSize: 15,
    },
    spinner: {
      marginTop: 8,
    },
    list: {
      gap: 8,
    },
    muted: {
      color: colors.textMuted,
      fontSize: 14,
    },
    error: {
      color: colors.danger,
      fontSize: 13,
      backgroundColor: colors.dangerSurface,
      borderRadius: 8,
      padding: 10,
    },
  });
