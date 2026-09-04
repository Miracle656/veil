import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

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
        <Text style={styles.empty}>Loading…</Text>
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
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
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
