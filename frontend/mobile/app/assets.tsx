import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { errorMessage } from '../lib/errorMessage';
import { AssetRow } from '../components/AssetRow';
import { TokenIcon } from '../components/TokenIcon';
import { ScreenScaffold } from '../components/ScreenScaffold';
import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import {
  ASSET_REGISTRY,
  classicAccountExists,
  fetchHeldAssets,
  fetchIssuerFlags,
  getAssetControlDisclosure,
  loadWalletAddress,
  type HeldAsset,
  type RegisteredAsset,
} from '../lib/assets';
import { fetchPrice, formatUsd, usdValue } from '../lib/fetchPrice';
import { getNetworkName } from '../lib/network';
import {
  enableTrustline,
  removeTrustline,
  AccountNotFunded,
  NotEnoughXlm,
  NonZeroBalanceError,
} from '../lib/enableUsdc';
import {
  calculateSpendableAfterTrustline,
  TRUSTLINE_RESERVE_COST_XLM,
  TRUSTLINE_RESERVE_EXPLANATION,
} from '../lib/reserves';

/**
 * Trustlines and reserves.
 *
 * This page used to carry one hand-written banner per offerable asset — three
 * of them, each with its own `enabling` flag, its own message state, its own
 * `hasX` memo and its own copy of the same twenty lines. Adding EURC and AQUA
 * would have made five. It is driven from `ASSET_REGISTRY` now: an asset
 * registered as live on the active network and not already held is offered,
 * and adding the next one is a registry entry and nothing here.
 *
 * What the issuer can do to a balance is read from the issuing account rather
 * than written into the copy. The old page stated it for USDT0 only, in prose,
 * which was right for USDT0 and silent about USDY and EURC — whose issuers can
 * also freeze.
 */

type ControlNotes = Record<string, string | null>;

type State =
  | { kind: 'loading' }
  | { kind: 'no-wallet' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready';
      assets: HeldAsset[];
      prices: Record<string, number | null>;
      xlmBalance: string;
      control: ControlNotes;
      /** False when no classic account backs this wallet yet. */
      accountExists: boolean;
    };

export default function AssetsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busyCode, setBusyCode] = useState<string | null>(null);
  const [removingAsset, setRemovingAsset] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: 'success' | 'error' } | null>(null);
  // The page has always advertised a pull-to-refresh it did not have: the old
  // ScrollView was plain, so the gesture did nothing and the only way to retry
  // a failed load was to leave the screen and come back.
  const [refreshing, setRefreshing] = useState(false);

  const network = getNetworkName();

  /** Registry assets live on this network, in registry order. */
  const offerable = useMemo(
    () =>
      Object.values(ASSET_REGISTRY).filter(
        (a) => a.network === undefined || a.network === network,
      ),
    [network],
  );

  const load = useCallback(async () => {
    try {
      const address = await loadWalletAddress();
      if (!address) {
        setState({ kind: 'no-wallet' });
        return;
      }
      const assets = await fetchHeldAssets(address);

      const prices: Record<string, number | null> = {};
      await Promise.all(
        assets.map(async (asset) => {
          prices[`${asset.code}:${asset.issuer}`] = await fetchPrice(asset.code, asset.issuer);
        }),
      );

      // What each registry issuer can do to a balance of its asset. Read from
      // the issuing account, so it is the same answer for every holder, and
      // null when Horizon cannot say — never a reassurance we did not earn.
      const control: ControlNotes = {};
      await Promise.all(
        Object.values(ASSET_REGISTRY).map(async (a) => {
          control[a.code] = getAssetControlDisclosure(await fetchIssuerFlags(a.issuer));
        }),
      );

      const xlmBalance = assets.find((a) => a.code === 'XLM')?.balance ?? '0';
      setState({
        kind: 'ready',
        assets,
        prices,
        xlmBalance,
        control,
        accountExists: classicAccountExists(),
      });
    } catch (err) {
      setState({ kind: 'error', message: errorMessage(err) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const held = useMemo(() => {
    if (state.kind !== 'ready') return new Set<string>();
    // Matched on code AND issuer: a trustline to an impostor sharing a
    // registered code must not read as "you already have this".
    return new Set(state.assets.map((a) => `${a.code.toUpperCase()}:${a.issuer}`));
  }, [state]);

  const spendableImpact = useMemo(() => {
    if (state.kind !== 'ready') return null;
    return calculateSpendableAfterTrustline(state.xlmBalance, 1);
  }, [state]);

  const handleEnable = useCallback(
    async (asset: RegisteredAsset) => {
      setBusyCode(asset.code);
      setNotice(null);
      try {
        const txHash = await enableTrustline(asset.code);
        setNotice({
          text: txHash
            ? `${asset.code} is on. ${TRUSTLINE_RESERVE_COST_XLM} XLM locked as reserve (tx ${txHash.slice(0, 8)}…).`
            : `${asset.code} was already enabled.`,
          tone: 'success',
        });
        await load();
      } catch (err) {
        if (err instanceof NotEnoughXlm) {
          setNotice({
            text: `This account holds ${err.have} XLM. Adding a ${asset.code} trustline needs about 0.6 XLM of refundable reserve.`,
            tone: 'error',
          });
        } else if (err instanceof AccountNotFunded) {
          setNotice({
            text: 'This account does not exist on the network yet, so it cannot add a trustline.',
            tone: 'error',
          });
        } else {
          setNotice({ text: errorMessage(err), tone: 'error' });
        }
      } finally {
        setBusyCode(null);
      }
    },
    [load],
  );

  const handleRemoveTrustline = useCallback(
    async (code: string) => {
      setRemovingAsset(code);
      setNotice(null);
      try {
        const txHash = await removeTrustline(code);
        setNotice({
          text: `Removed ${code} and returned ${TRUSTLINE_RESERVE_COST_XLM} XLM to your spendable balance (tx ${txHash.slice(0, 8)}…).`,
          tone: 'success',
        });
        await load();
      } catch (err) {
        if (err instanceof NonZeroBalanceError) {
          setNotice({ text: err.message, tone: 'error' });
        } else {
          setNotice({ text: errorMessage(err), tone: 'error' });
        }
      } finally {
        setRemovingAsset(null);
      }
    },
    [load],
  );

  const renderBody = () => {
    if (state.kind === 'loading') {
      return <ActivityIndicator color={colors.accent} style={styles.spinner} />;
    }
    if (state.kind === 'no-wallet') {
      return <Text style={styles.muted}>No wallet found on this device yet.</Text>;
    }
    if (state.kind === 'error') {
      return (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{state.message}</Text>
          <Pressable
            onPress={() => {
              setState({ kind: 'loading' });
              void load();
            }}
            accessibilityRole="button"
            accessibilityLabel="Try again"
            style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
          >
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      );
    }

    const available = offerable.filter(
      (a) => !held.has(`${a.code.toUpperCase()}:${a.issuer}`),
    );

    return (
      <View style={styles.body}>
        {/* Reserve first. Every action below costs some of it. */}
        <View style={styles.reserveCard}>
          <Text style={styles.eyebrow}>SPENDABLE</Text>
          <Text style={styles.reserveValue}>{state.xlmBalance} XLM</Text>
          <Text style={styles.reserveHint}>{TRUSTLINE_RESERVE_EXPLANATION}</Text>
        </View>

        {notice ? (
          <Text style={[styles.notice, notice.tone === 'error' && styles.noticeError]}>
            {notice.text}
          </Text>
        ) : null}

        {/* A trustline is an entry on the CLASSIC account, and a smart wallet
            can hold XLM in its contract without one existing yet. Saying so
            beats listing five assets whose Add button can only fail. */}
        {!state.accountExists ? (
          <View style={styles.offer}>
            <Text style={styles.offerCode}>No classic account yet</Text>
            <Text style={styles.offerMeta}>
              Trustlines live on a classic Stellar account, and this wallet does not
              have one on the network yet. Receive any amount of XLM to that address
              first — then these assets can be added.
            </Text>
          </View>
        ) : null}

        {state.accountExists && available.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Available to add</Text>
            {available.map((asset) => (
              <View key={asset.code} style={styles.offer}>
                <View style={styles.offerHead}>
                  <TokenIcon code={asset.code} size={38} />
                  <View style={styles.offerText}>
                    <Text style={styles.offerCode}>{asset.code}</Text>
                    <Text style={styles.offerName}>{asset.name}</Text>
                  </View>
                </View>

                <Text style={styles.offerMeta}>
                  Issued by {asset.issuerName}
                  {asset.homeDomain ? ` · ${asset.homeDomain}` : ''}
                </Text>
                <Text style={styles.offerMeta}>
                  Costs {TRUSTLINE_RESERVE_COST_XLM} XLM of reserve — locked, not spent, and
                  returned if you remove it
                  {spendableImpact ? `. Spendable after: ${spendableImpact.projectedSpendable} XLM` : ''}
                </Text>
                {state.control[asset.code] ? (
                  <Text style={styles.offerWarn}>{state.control[asset.code]}</Text>
                ) : null}

                <Pressable
                  onPress={() => void handleEnable(asset)}
                  disabled={busyCode !== null}
                  accessibilityRole="button"
                  accessibilityLabel={`Add ${asset.code}`}
                  style={({ pressed }) => [
                    styles.enable,
                    (busyCode !== null || pressed) && styles.pressed,
                  ]}
                >
                  {busyCode === asset.code ? (
                    <ActivityIndicator size="small" color={colors.onAccent} />
                  ) : (
                    <Text style={styles.enableText}>Add {asset.code}</Text>
                  )}
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Holding</Text>
          {state.assets.length === 0 ? (
            <Text style={styles.muted}>
              Nothing beyond XLM yet. Add an asset above to hold it.
            </Text>
          ) : (
            state.assets.map((asset) => {
              const key = `${asset.code}:${asset.issuer}`;
              const formatted = formatUsd(usdValue(asset.balance, state.prices[key] ?? null));
              const isNonNative = asset.code !== 'XLM';
              const canRemove = isNonNative && Number(asset.balance) === 0;
              const isRemoving = removingAsset === asset.code;

              return (
                <View key={key} style={styles.assetCard}>
                  <AssetRow
                    asset={asset}
                    usdValueFormatted={formatted !== '—' ? formatted : undefined}
                  />
                  {isNonNative ? (
                    <View style={styles.trustlineFooter}>
                      <Text style={styles.reserveTag}>
                        {TRUSTLINE_RESERVE_COST_XLM} XLM locked
                      </Text>
                      {canRemove ? (
                        <Pressable
                          onPress={() => void handleRemoveTrustline(asset.code)}
                          disabled={isRemoving}
                          accessibilityRole="button"
                          accessibilityLabel={`Remove ${asset.code}`}
                          style={({ pressed }) => [styles.remove, pressed && styles.pressed]}
                        >
                          {isRemoving ? (
                            <ActivityIndicator size="small" color={colors.danger} />
                          ) : (
                            <Text style={styles.removeText}>
                              Remove, reclaim {TRUSTLINE_RESERVE_COST_XLM} XLM
                            </Text>
                          )}
                        </Pressable>
                      ) : (
                        <Text style={styles.refusal}>
                          Move the balance out first to reclaim the reserve
                        </Text>
                      )}
                    </View>
                  ) : null}
                </View>
              );
            })
          )}
        </View>
      </View>
    );
  };

  return (
    <ScreenScaffold
      eyebrow="TRUSTLINES"
      title="Assets"
      description="Which assets this wallet can hold, and the XLM each one locks."
      testID="assets-screen"
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
      }
    >
      {renderBody()}
    </ScreenScaffold>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    body: { gap: 20, paddingBottom: 24 },
    spinner: { marginTop: 32 },
    muted: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 13.5,
      lineHeight: 20,
    },

    errorBox: { gap: 12, paddingTop: 8 },
    errorText: {
      color: colors.danger,
      fontFamily: fontFamily.body,
      fontSize: 13.5,
      lineHeight: 20,
    },
    retry: {
      alignSelf: 'flex-start',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 999,
      paddingHorizontal: 18,
      paddingVertical: 9,
    },
    retryText: {
      color: colors.accent,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 13,
    },

    reserveCard: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 18,
      padding: 16,
      gap: 6,
    },
    eyebrow: {
      color: colors.accent,
      fontFamily: fontFamily.accent,
      fontSize: 10,
      letterSpacing: 0.8,
    },
    reserveValue: {
      color: colors.textStrong,
      fontFamily: fontFamily.address,
      fontSize: 22,
    },
    reserveHint: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 12.5,
      lineHeight: 19,
    },

    notice: {
      color: colors.textPrimary,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 20,
    },
    noticeError: { color: colors.danger },

    section: { gap: 12 },
    sectionTitle: {
      color: colors.accent,
      fontFamily: fontFamily.accent,
      fontSize: 11,
      letterSpacing: 0.8,
      textTransform: 'uppercase',
    },

    offer: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 18,
      padding: 16,
      gap: 8,
    },
    offerHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    offerText: { flexShrink: 1 },
    offerCode: {
      color: colors.textStrong,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
    },
    offerName: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 12.5,
      marginTop: 1,
    },
    offerMeta: {
      color: colors.textFaint,
      fontFamily: fontFamily.body,
      fontSize: 12,
      lineHeight: 18,
    },
    offerWarn: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 12,
      lineHeight: 18,
    },
    enable: {
      marginTop: 4,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accent,
      borderRadius: 999,
      paddingVertical: 11,
    },
    enableText: {
      color: colors.onAccent,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 14,
    },

    assetCard: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 18,
      padding: 14,
      gap: 10,
    },
    trustlineFooter: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      flexWrap: 'wrap',
      gap: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      paddingTop: 10,
    },
    reserveTag: {
      color: colors.textFaint,
      fontFamily: fontFamily.address,
      fontSize: 11.5,
    },
    remove: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.danger,
      borderRadius: 999,
      paddingHorizontal: 14,
      paddingVertical: 7,
    },
    removeText: {
      color: colors.danger,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 12,
    },
    refusal: {
      color: colors.textFaint,
      fontFamily: fontFamily.body,
      fontSize: 11.5,
      flexShrink: 1,
    },
    pressed: { opacity: 0.6 },
  });
