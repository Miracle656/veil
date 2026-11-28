import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { Skeleton } from './Skeleton';
import { TokenIcon } from './TokenIcon';
import { useTheme } from '../hooks/useTheme';
import { useCurrency } from '../hooks/useCurrency';
import { useHiddenAmounts } from '../hooks/useHiddenAmounts';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
// The ONE holdings loader — shared with the send/swap screens. This component
// once had its own private copy that hit Horizon with the raw (contract)
// address and threw; keep the implementations unified or the dashboard and the
// flow screens will disagree again.
import { loadHoldings, type Holding } from '../lib/holdings';
import { loadSoroswapLpPositions, type LpPosition } from '../lib/soroswapLpPositions';

/** Trim a raw balance to at most 4 decimals, grouped. */
function fmtAmount(raw: string): string {
  const n = Number(raw);
  if (!isFinite(n)) return raw;
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function fmtPositionAmount(raw: string): string {
  const [whole, fraction = ''] = raw.split('.');
  const scaled = BigInt(whole || '0') * 10_000n + BigInt((fraction + '0000').slice(0, 4));
  const rounded = scaled + (Number(fraction[4] ?? '0') >= 5 ? 1n : 0n);
  const groupedWhole = (rounded / 10_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const visibleFraction = (rounded % 10_000n).toString().padStart(4, '0').replace(/0+$/, '');
  return `${groupedWhole}${visibleFraction ? `.${visibleFraction}` : ''}`;
}

/**
 * The wallet's portfolio — one row per held asset (native XLM + trustlines), with
 * a token badge, name, on-chain balance, and its value in the user's currency.
 * Mirrors the assets list every consumer wallet shows under the balance.
 */
export function AssetsList({
  address,
  fallbackXlm = null,
  fallbackUsd = null,
}: {
  address: string | null;
  /** Dashboard's own XLM figure — shown as the XLM row if holdings can't load. */
  fallbackXlm?: string | null;
  /** USD value of that fallback balance. */
  fallbackUsd?: number | null;
}) {
  const router = useRouter();
  const { colors } = useTheme();
  const { format } = useCurrency();
  const { mask } = useHiddenAmounts();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [holdings, setHoldings] = useState<Holding[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    if (!address) {
      setHoldings([]);
      return;
    }
    try {
      setHoldings(await loadHoldings(address));
      setLoadError(false);
    } catch (err) {
      console.warn('[assets] loadHoldings failed:', err instanceof Error ? `${err.name}: ${err.message}` : err);
      // Fall back to the dashboard's own balance figure (fetched through a
      // different, independently-working path) rather than showing nothing.
      if (fallbackXlm) {
        setHoldings([
          { code: 'XLM', name: 'Lumens', issuer: null, balance: fallbackXlm, usd: fallbackUsd, native: true },
        ]);
        setLoadError(false);
      } else {
        setHoldings([]);
        setLoadError(true);
      }
    }
  }, [address, fallbackXlm, fallbackUsd]);

  useEffect(() => {
    void load();
  }, [load]);

  // Reload on focus so new trustlines/balances (e.g. USDC after a swap) appear.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <View style={styles.card}>
      <Text style={styles.heading}>Assets</Text>
      {holdings === null ? (
        // Shaped like the rows that replace it — icon, name over code, balance
        // over fiat — so the card keeps its height and nothing jumps on load.
        <View>
          {[0, 1, 2].map((i) => (
            <View key={i} style={[styles.row, i > 0 && styles.rowBorder]}>
              <View style={styles.left}>
                <Skeleton width={38} height={38} radius={19} />
                <View style={styles.skeletonText}>
                  <Skeleton width={76} height={13} />
                  <Skeleton width={40} height={11} />
                </View>
              </View>
              <View style={styles.skeletonRight}>
                <Skeleton width={64} height={13} />
                <Skeleton width={44} height={11} />
              </View>
            </View>
          ))}
        </View>
      ) : holdings.length === 0 ? (
        <Text style={styles.empty}>
          {loadError ? "Couldn't load assets — pull to refresh." : 'No assets yet. Fund this wallet to get started.'}
        </Text>
      ) : (
        holdings.map((h, i) => (
          <Pressable
            key={`${h.code}-${h.issuer ?? 'native'}`}
            onPress={() => router.push(`/token/${encodeURIComponent(h.issuer ? `${h.code}:${h.issuer}` : h.code)}`)}
            accessibilityRole="button"
            accessibilityLabel={`${h.name} details`}
            style={({ pressed }) => [styles.row, i > 0 && styles.rowBorder, pressed && styles.pressed]}
          >
            <View style={styles.left}>
              <TokenIcon code={h.code} size={38} />
              <View>
                <Text style={styles.name}>{h.name}</Text>
                <Text style={styles.code}>{h.code}</Text>
              </View>
            </View>
            <View style={styles.right}>
              <Text style={styles.balance}>{mask(fmtAmount(h.balance))}</Text>
              <Text style={styles.fiat}>{h.usd === null ? '—' : mask(format(h.usd))}</Text>
            </View>
          </Pressable>
        ))
      )}
      {address && <LpPositionsSection address={address} format={format} styles={styles} />}
    </View>
  );
}

function LpPositionsSection({
  address,
  format,
  styles,
}: {
  address: string;
  format: (amount: number) => string;
  styles: ReturnType<typeof createStyles>;
}) {
  const { mask } = useHiddenAmounts();
  const [positions, setPositions] = useState<LpPosition[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      setPositions(null);
      setLoadError(false);
      void loadSoroswapLpPositions(address)
        .then((loaded) => {
          if (active) {
            setPositions(loaded);
            setLoadError(false);
          }
        })
        .catch((err: unknown) => {
          console.warn(
            '[assets] loadSoroswapLpPositions failed:',
            err instanceof Error ? `${err.name}: ${err.message}` : err
          );
          if (active) {
            setPositions([]);
            setLoadError(true);
          }
        });
      return () => {
        active = false;
      };
    }, [address])
  );

  return (
    <View style={styles.lpSection}>
      <Text style={styles.heading}>LP Positions</Text>
      {positions === null ? (
        <Text style={styles.empty}>Loading LP positions…</Text>
      ) : loadError ? (
        <Text style={styles.empty}>Couldn’t load LP positions. Reopen this screen to retry.</Text>
      ) : positions.length === 0 ? (
        <Text style={styles.empty}>No Soroswap LP positions found.</Text>
      ) : (
        positions.map((position, index) => (
          <View key={position.pairId} style={[styles.lpPosition, index > 0 && styles.rowBorder]}>
            <View style={styles.lpPositionHeader}>
              <View>
                <Text style={styles.name}>LP Position</Text>
                <Text style={styles.code}>
                  {position.tokenA}/{position.tokenB}
                </Text>
              </View>
              <Text style={styles.balance}>{mask(fmtPositionAmount(position.lpBalance))} LP</Text>
            </View>
            <Text style={styles.lpDetail}>
              {mask(fmtPositionAmount(position.underlyingA))} {position.tokenA} +{' '}
              {mask(fmtPositionAmount(position.underlyingB))} {position.tokenB}
            </Text>
            <View style={styles.lpPositionFooter}>
              <Text style={styles.code}>{position.ownershipPercent}% of pool</Text>
              <Text style={styles.fiat}>
                {position.usd === null ? 'Value unavailable' : mask(format(position.usd))}
              </Text>
            </View>
          </View>
        ))
      )}
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      // TEMP(layout preview): outer border removed — the surface fill already
      // separates the card from the page. Row dividers below are kept.
      borderRadius: 20,
      paddingHorizontal: 18,
      paddingTop: 12,
      paddingBottom: 6,
    },
    lpSection: {
      borderTopWidth: 1,
      borderTopColor: colors.border,
      marginTop: 8,
      paddingTop: 8,
    },
    heading: {
      color: colors.accent,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 11,
      letterSpacing: 1.4,
      textTransform: 'uppercase',
      paddingVertical: 4,
    },
    empty: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 13,
      paddingVertical: 12,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 13,
    },
    rowBorder: {
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    skeletonText: {
      gap: 6,
    },
    skeletonRight: {
      alignItems: 'flex-end',
      gap: 6,
    },
    pressed: { opacity: 0.6 },
    left: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      flexShrink: 1,
    },
    name: {
      color: colors.textPrimary,
      fontFamily: fontFamily.bodyMedium,
      fontSize: 14.5,
    },
    code: {
      color: colors.textFaint,
      fontFamily: fontFamily.body,
      fontSize: 11,
      marginTop: 2,
    },
    right: {
      alignItems: 'flex-end',
    },
    balance: {
      color: colors.textPrimary,
      fontFamily: fontFamily.address,
      fontSize: 14.5,
    },
    fiat: {
      color: colors.textFaint,
      fontFamily: fontFamily.body,
      fontSize: 11,
      marginTop: 2,
    },
    lpPosition: {
      paddingVertical: 13,
      gap: 7,
    },
    lpPositionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    },
    lpDetail: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 12,
    },
    lpPositionFooter: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
  });
