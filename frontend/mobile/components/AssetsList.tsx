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

/** Trim a raw balance to at most 4 decimals, grouped. */
function fmtAmount(raw: string): string {
  const n = Number(raw);
  if (!isFinite(n)) return raw;
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/**
 * The wallet's portfolio — one row per held asset (native XLM + trustlines), with
 * a token badge, name, on-chain balance, and its value in the user's currency.
 * Mirrors the assets list every consumer wallet shows under the balance.
 */
/**
 * Last-known holdings, surviving the remount that unlocking causes.
 *
 * The balance card above already does this; the asset list did not, so every
 * unlock dropped back to skeletons and refetched from nothing even though the
 * answer had not changed.
 *
 * Scoped to the wallet ADDRESS for the same reason the card's is: after a reset
 * or a new wallet, the previous wallet's assets must never paint under the new
 * address.
 */
const lastKnown: { address: string | null; holdings: Holding[] | null } = {
  address: null,
  holdings: null,
};

/** Keep a load for the next mount. Switching address discards the old one. */
function remember(address: string, holdings: Holding[]): void {
  lastKnown.address = address;
  lastKnown.holdings = holdings;
}

export type AssetsView = 'loading' | 'empty' | 'error' | 'list';

/**
 * Which of the four states the card is in.
 *
 * The distinction this exists to protect: `null` holdings means **not known
 * yet**, and an empty array means **known, and empty**. Collapsing the two is
 * what put "No assets yet. Fund this wallet to get started." in front of a
 * funded wallet every time the app unlocked.
 */
export function assetsView(holdings: Holding[] | null, loadError: boolean): AssetsView {
  if (holdings === null) return 'loading';
  if (holdings.length > 0) return 'list';
  return loadError ? 'error' : 'empty';
}

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

  const [holdings, setHoldings] = useState<Holding[] | null>(() =>
    address && lastKnown.address === address ? lastKnown.holdings : null,
  );
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    // No address yet means "not known yet", which is what `null` holdings
    // already says — so leave the state alone and keep the skeleton up.
    //
    // This used to `setHoldings([])`, and an empty array is how this component
    // asserts that a wallet HAS NOTHING. The dashboard reads the stored address
    // asynchronously, so for the first frames after an unlock it passes null,
    // and the card answered a question it had not asked yet: "No assets yet.
    // Fund this wallet to get started." in front of a funded wallet.
    if (!address) return;
    try {
      const next = await loadHoldings(address);
      remember(address, next);
      setHoldings(next);
      setLoadError(false);
    } catch (err) {
      console.warn('[assets] loadHoldings failed:', err instanceof Error ? `${err.name}: ${err.message}` : err);
      // Fall back to the dashboard's own balance figure (fetched through a
      // different, independently-working path) rather than showing nothing.
      if (fallbackXlm) {
        const fallback: Holding[] = [
          { code: 'XLM', name: 'Lumens', issuer: null, balance: fallbackXlm, usd: fallbackUsd, native: true },
        ];
        remember(address, fallback);
        setHoldings(fallback);
        setLoadError(false);
      } else {
        // Flag the error, but do not overwrite holdings we already have. An
        // empty array here would replace a correct list with "no assets"
        // because one refresh could not reach the network — and `assetsView`
        // keeps showing a stale list over an error for the same reason.
        setLoadError(true);
        setHoldings((prev) => prev ?? []);
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

  // One source of truth for which state is on screen, so the loading/empty
  // distinction lives in a tested function rather than in a chain of ternaries
  // where `null` and `[]` read the same.
  const view = assetsView(holdings, loadError);

  return (
    <View style={styles.card}>
      <Text style={styles.heading}>Assets</Text>
      {view === 'loading' ? (
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
      ) : view === 'error' ? (
        <Text style={styles.empty}>Couldn’t load assets — pull to refresh.</Text>
      ) : view === 'empty' ? (
        <Text style={styles.empty}>No assets yet. Fund this wallet to get started.</Text>
      ) : (
        (holdings ?? []).map((h, i) => (
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
  });
