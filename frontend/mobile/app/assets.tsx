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
  getRegisteredAsset,
  type HeldAsset,
} from '../lib/assets';
import { fetchPrice, formatUsd, usdValue } from '../lib/fetchPrice';
import { getNetworkName } from '../lib/network';
import {
  enableUsdy,
  removeTrustline,
  calculateSpendableAfterTrustline,
  AccountNotFunded,
  NotEnoughXlm,
  NonZeroBalanceError,
} from '../lib/enableUsdc';

type State =
  | { kind: 'loading' }
  | { kind: 'no-wallet' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; assets: HeldAsset[]; prices: Record<string, number | null>; xlmBalance: string };

export default function AssetsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [enablingUsdy, setEnablingUsdy] = useState(false);
  const [removingAsset, setRemovingAsset] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ text: string; tone: 'success' | 'error' } | null>(null);

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

      const nativeAsset = assets.find((a) => a.code === 'XLM');
      const xlmBalance = nativeAsset?.balance ?? '0';

      setState({ kind: 'ready', assets, prices, xlmBalance });
    } catch (err) {
      setState({ kind: 'error', message: errorMessage(err) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleEnableUsdy = useCallback(async () => {
    setEnablingUsdy(true);
    setActionMessage(null);
    try {
      const txHash = await enableUsdy();
      if (txHash) {
        setActionMessage({
          text: `USDY trustline enabled successfully! 0.5 XLM locked as reserve. (Tx: ${txHash.slice(0, 8)}…)`,
          tone: 'success',
        });
      } else {
        setActionMessage({ text: 'USDY trustline is already enabled.', tone: 'success' });
      }
      await load();
    } catch (err) {
      if (err instanceof NotEnoughXlm) {
        setActionMessage({
          text: `This account holds ${err.have} XLM. Adding a USDY trustline needs about 0.6 XLM of refundable reserve.`,
          tone: 'error',
        });
      } else if (err instanceof AccountNotFunded) {
        setActionMessage({
          text: 'This account does not exist on the network yet, so it cannot add a trustline.',
          tone: 'error',
        });
      } else {
        setActionMessage({ text: errorMessage(err), tone: 'error' });
      }
    } finally {
      setEnablingUsdy(false);
    }
  }, [load]);

  const handleRemoveTrustline = useCallback(
    async (code: string) => {
      setRemovingAsset(code);
      setActionMessage(null);
      try {
        const txHash = await removeTrustline(code);
        setActionMessage({
          text: `Removed ${code} trustline and returned 0.5 XLM reserve to your spendable balance! (Tx: ${txHash.slice(0, 8)}…)`,
          tone: 'success',
        });
        await load();
      } catch (err) {
        if (err instanceof NonZeroBalanceError) {
          setActionMessage({ text: err.message, tone: 'error' });
        } else {
          setActionMessage({ text: errorMessage(err), tone: 'error' });
        }
      } finally {
        setRemovingAsset(null);
      }
    },
    [load],
  );

  const hasUsdy = useMemo(() => {
    if (state.kind !== 'ready') return false;
    return state.assets.some(
      (a) => a.code.toUpperCase() === 'USDY' && a.issuer === USDY_MAINNET_ISSUER,
    );
  }, [state]);

  const usdyRegistered = getRegisteredAsset('USDY');
  const onMainnet = getNetworkName() === 'mainnet';

  const spendableImpact = useMemo(() => {
    if (state.kind !== 'ready') return null;
    return calculateSpendableAfterTrustline(state.xlmBalance, 1);
  }, [state]);

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Assets</Text>
        <ThemeToggle />
      </View>
      <Text style={styles.subtitle}>Every asset your wallet holds beyond XLM.</Text>

      {state.kind === 'ready' && (
        <View style={styles.spendableBanner}>
          <Text style={styles.spendableLabel}>Spendable Balance</Text>
          <Text style={styles.spendableValue}>{state.xlmBalance} XLM</Text>
          <Text style={styles.spendableHint}>
            Each enabled trustline locks 0.5 XLM base reserve. Removing an empty trustline returns its 0.5 XLM.
          </Text>
        </View>
      )}

      {/* Featured USDY One-Tap Trustline Action. Mainnet only — USDY's issuer
          does not exist on testnet. */}
      {state.kind === 'ready' && !hasUsdy && onMainnet && (
        <View style={styles.usdyBanner}>
          <View style={styles.usdyInfo}>
            <Text style={styles.usdyTitle}>Enable USDY</Text>
            <Text style={styles.usdyDescription}>
              {usdyRegistered?.name ?? "Ondo's US Treasuries-backed, yield-bearing token."}
            </Text>
            <View style={styles.reserveBreakdown}>
              <Text style={styles.usdyReserveNotice}>• Reserve cost: 0.5 XLM (refundable when removed)</Text>
              {spendableImpact && (
                <Text style={styles.usdyReserveNotice}>
                  • Projected spendable after: {spendableImpact.projectedSpendable} XLM
                </Text>
              )}
            </View>
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
              <Text style={styles.enableButtonText}>Enable USDY (0.5 XLM reserve)</Text>
            )}
          </Pressable>
        </View>
      )}

      {actionMessage && (
        <Text style={[styles.actionNotice, actionMessage.tone === 'error' && styles.actionNoticeError]}>
          {actionMessage.text}
        </Text>
      )}

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
              const isNonNative = asset.code !== 'XLM';
              const canRemove = isNonNative && Number(asset.balance) === 0;
              const isRemoving = removingAsset === asset.code;

              return (
                <View key={key} style={styles.assetCard}>
                  <AssetRow
                    asset={asset}
                    usdValueFormatted={formattedVal !== '—' ? formattedVal : undefined}
                  />
                  {isNonNative && (
                    <View style={styles.trustlineFooter}>
                      <Text style={styles.reserveTag}>Locked reserve: 0.5 XLM</Text>
                      {canRemove ? (
                        <Pressable
                          onPress={() => void handleRemoveTrustline(asset.code)}
                          disabled={isRemoving}
                          style={({ pressed }) => [
                            styles.removeButton,
                            pressed && styles.buttonPressed,
                          ]}
                        >
                          {isRemoving ? (
                            <ActivityIndicator size="small" color={colors.danger} />
                          ) : (
                            <Text style={styles.removeButtonText}>Remove &amp; Reclaim 0.5 XLM</Text>
                          )}
                        </Pressable>
                      ) : (
                        <Text style={styles.refusalNote}>
                          Non-zero balance: transfer funds out to reclaim reserve
                        </Text>
                      )}
                    </View>
                  )}
                </View>
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
    usdyBanner: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 14,
      padding: 16,
      gap: 12,
    },
    usdyInfo: {
      gap: 4,
    },
    usdyTitle: {
      color: colors.textStrong,
      fontSize: 17,
      fontWeight: '700',
    },
    usdyDescription: {
      color: colors.textSecondary,
      fontSize: 13,
      lineHeight: 18,
    },
    usdyReserveNotice: {
      color: colors.accent,
      fontSize: 12,
      fontWeight: '600',
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
    spendableBanner: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 14,
      padding: 16,
      gap: 4,
    },
    spendableLabel: {
      color: colors.textSecondary,
      fontSize: 12,
      fontWeight: '600',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    spendableValue: {
      color: colors.textStrong,
      fontSize: 22,
      fontWeight: '700',
    },
    spendableHint: {
      color: colors.textMuted,
      fontSize: 12,
      lineHeight: 16,
      marginTop: 2,
    },
    reserveBreakdown: {
      gap: 2,
      marginTop: 2,
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
    actionNoticeError: {
      borderColor: 'rgba(220,38,38,0.35)',
      backgroundColor: colors.dangerSurface,
      color: colors.danger,
    },
    assetCard: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 14,
      padding: 12,
      gap: 8,
    },
    trustlineFooter: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: 8,
      gap: 8,
    },
    reserveTag: {
      color: colors.accent,
      fontSize: 12,
      fontWeight: '500',
    },
    removeButton: {
      backgroundColor: colors.dangerSurface,
      borderColor: 'rgba(220,38,38,0.35)',
      borderWidth: 1,
      borderRadius: 8,
      paddingVertical: 6,
      paddingHorizontal: 10,
    },
    removeButtonText: {
      color: colors.danger,
      fontSize: 12,
      fontWeight: '600',
    },
    refusalNote: {
      color: colors.textMuted,
      fontSize: 11,
      flex: 1,
      textAlign: 'right',
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
