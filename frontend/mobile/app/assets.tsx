import { errorMessage } from '../lib/errorMessage';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AssetRow } from '../components/AssetRow';
import { ThemeToggle } from '../components/ThemeToggle';
import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import {
  fetchHeldAssets,
  loadWalletAddress,
  USDY_MAINNET_ISSUER,
  USDT0_MAINNET_ISSUER,
  getRegisteredAsset,
  type HeldAsset,
} from '../lib/assets';
import { fetchPrice, formatUsd, usdValue } from '../lib/fetchPrice';
import { getNetworkName } from '../lib/network';
import { enableUsdc, enableUsdy, enableUsdt0, AccountNotFunded, NotEnoughXlm } from '../lib/enableUsdc';

type State =
  | { kind: 'loading' }
  | { kind: 'no-wallet' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; assets: HeldAsset[]; prices: Record<string, number | null> };

export default function AssetsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [enablingUsdy, setEnablingUsdy] = useState(false);
  const [usdyActionMessage, setUsdyActionMessage] = useState<string | null>(null);
  const [enablingUsdt0, setEnablingUsdt0] = useState(false);
  const [usdt0ActionMessage, setUsdt0ActionMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const address = await loadWalletAddress();
      if (!address) {
        setState({ kind: 'no-wallet' });
        return;
      }
      const assets = await fetchHeldAssets(address);

      // Fetch USD prices for all held assets
      const prices: Record<string, number | null> = {};
      await Promise.all(
        assets.map(async (asset) => {
          const key = `${asset.code}:${asset.issuer}`;
          prices[key] = await fetchPrice(asset.code, asset.issuer);
        }),
      );

      setState({ kind: 'ready', assets, prices });
    } catch (err) {
      setState({ kind: 'error', message: errorMessage(err) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleEnableUsdy = useCallback(async () => {
    setEnablingUsdy(true);
    setUsdyActionMessage(null);
    try {
      const txHash = await enableUsdy();
      if (txHash) {
        setUsdyActionMessage(`USDY trustline enabled successfully! (Tx: ${txHash.slice(0, 8)}…)`);
      } else {
        setUsdyActionMessage('USDY trustline is already enabled.');
      }
      await load();
    } catch (err) {
      if (err instanceof NotEnoughXlm) {
        setUsdyActionMessage(
          `This account holds ${err.have} XLM. Adding a USDY trustline needs about 0.6 XLM of refundable reserve.`,
        );
      } else if (err instanceof AccountNotFunded) {
        setUsdyActionMessage(
          'This account does not exist on the network yet, so it cannot add a trustline.',
        );
      } else {
        setUsdyActionMessage(errorMessage(err));
      }
    } finally {
      setEnablingUsdy(false);
    }
  }, [load]);

  const handleEnableUsdt0 = useCallback(async () => {
    setEnablingUsdt0(true);
    setUsdt0ActionMessage(null);
    try {
      const txHash = await enableUsdt0();
      if (txHash) {
        setUsdt0ActionMessage(`USDT0 trustline enabled successfully! (Tx: ${txHash.slice(0, 8)}…)`);
      } else {
        setUsdt0ActionMessage('USDT0 trustline is already enabled.');
      }
      await load();
    } catch (err) {
      if (err instanceof NotEnoughXlm) {
        setUsdt0ActionMessage(
          `This account holds ${err.have} XLM. Adding a USDT0 trustline needs about 0.6 XLM of refundable reserve.`,
        );
      } else if (err instanceof AccountNotFunded) {
        setUsdt0ActionMessage(
          'This account does not exist on the network yet, so it cannot add a trustline.',
        );
      } else {
        setUsdt0ActionMessage(errorMessage(err));
      }
    } finally {
      setEnablingUsdt0(false);
    }
  }, [load]);

  const hasUsdy = useMemo(() => {
    if (state.kind !== 'ready') return false;
    return state.assets.some(
      (a) => a.code.toUpperCase() === 'USDY' && a.issuer === USDY_MAINNET_ISSUER,
    );
  }, [state]);

  const hasUsdt0 = useMemo(() => {
    if (state.kind !== 'ready') return false;
    return state.assets.some(
      (a) => a.code.toUpperCase() === 'USDT0' && a.issuer === USDT0_MAINNET_ISSUER,
    );
  }, [state]);

  const usdyRegistered = getRegisteredAsset('USDY');
  const usdt0Registered = getRegisteredAsset('USDT0');

  const onMainnet = getNetworkName() === 'mainnet';

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Assets</Text>
        <ThemeToggle />
      </View>
      <Text style={styles.subtitle}>Every asset your wallet holds beyond XLM.</Text>

      {/* Featured USDT0 One-Tap Trustline Action. Mainnet only — USDT0's issuer
          does not exist on testnet. */}
      {state.kind === 'ready' && !hasUsdt0 && onMainnet && (
        <View style={styles.banner}>
          <View style={styles.bannerInfo}>
            <Text style={styles.bannerTitle}>Enable USDT0</Text>
            <Text style={styles.bannerDescription}>
              {usdt0Registered?.name ?? "Tether's USD stablecoin bridged to Stellar."}
            </Text>
            <Text style={styles.reserveNotice}>
              Reserve cost: 0.5 XLM (locked, not spent — released if removed).
            </Text>
            <Text style={styles.disclosureText}>
              Note: The issuer can freeze this balance or take it back.
            </Text>
          </View>
          <Pressable
            onPress={handleEnableUsdt0}
            disabled={enablingUsdt0}
            style={({ pressed }) => [
              styles.enableButton,
              (enablingUsdt0 || pressed) && styles.buttonPressed,
            ]}
          >
            {enablingUsdt0 ? (
              <ActivityIndicator size="small" color={colors.onAccent} />
            ) : (
              <Text style={styles.enableButtonText}>Enable USDT0</Text>
            )}
          </Pressable>
        </View>
      )}

      {usdt0ActionMessage && <Text style={styles.actionNotice}>{usdt0ActionMessage}</Text>}

      {/* Featured USDY One-Tap Trustline Action. Mainnet only — USDY's issuer
          does not exist on testnet. */}
      {state.kind === 'ready' && !hasUsdy && onMainnet && (
        <View style={styles.banner}>
          <View style={styles.bannerInfo}>
            <Text style={styles.bannerTitle}>Enable USDY</Text>
            <Text style={styles.bannerDescription}>
              {usdyRegistered?.name ?? "Ondo's US Treasuries-backed, yield-bearing token."}
            </Text>
            <Text style={styles.reserveNotice}>
              Reserve cost: 0.5 XLM (locked, not spent — released if removed).
            </Text>

          </View>
          <Pressable
            onPress={handleEnableUsdy}
            disabled={enablingUsdy}
            style={({ pressed }) => [
              styles.enableButton,
              (enablingUsdy || pressed) && styles.buttonPressed,
            ]}
          >
            {enablingUsdy ? (
              <ActivityIndicator size="small" color={colors.onAccent} />
            ) : (
              <Text style={styles.enableButtonText}>Enable USDY</Text>
            )}
          </Pressable>
        </View>
      )}

      {usdyActionMessage && <Text style={styles.actionNotice}>{usdyActionMessage}</Text>}

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
            {state.assets.map((asset) => {
              const key = `${asset.code}:${asset.issuer}`;
              const price = state.prices[key] ?? null;
              const val = usdValue(asset.balance, price);
              const formattedVal = formatUsd(val);

              return (
                <AssetRow
                  key={key}
                  asset={asset}
                  usdValueFormatted={formattedVal !== '—' ? formattedVal : undefined}
                />
              );
            })}
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
    banner: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 14,
      padding: 16,
      gap: 12,
    },
    bannerInfo: {
      gap: 4,
    },
    bannerTitle: {
      color: colors.textStrong,
      fontSize: 17,
      fontWeight: '700',
    },
    bannerDescription: {
      color: colors.textSecondary,
      fontSize: 13,
      lineHeight: 18,
    },
    reserveNotice: {
      color: colors.accent,
      fontSize: 12,
      fontWeight: '600',
      marginTop: 2,
    },
    disclosureText: {
      color: colors.textMuted,
      fontSize: 12,
      fontStyle: 'italic',
      marginTop: 2,
    },
    enableButton: {
      backgroundColor: colors.accent,
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 16,
      alignItems: 'center',
      justifyContent: 'center',
    },
    buttonPressed: {
      opacity: 0.8,
    },
    enableButtonText: {
      color: colors.onAccent,
      fontSize: 14,
      fontWeight: '600',
    },
    actionNotice: {
      color: colors.textPrimary,
      fontSize: 13,
      backgroundColor: colors.surfaceMd,
      borderRadius: 8,
      padding: 10,
      borderWidth: 1,
      borderColor: colors.border,
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
