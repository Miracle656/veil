/**
 * Explore — design "2a", built from what Veil can actually answer.
 *
 * The design carries eight sections. Four of them need data this app does not
 * have, and inventing them is the one thing a screen about markets must not do:
 *
 *   - **Stocks.** `ASSET_REGISTRY` has an `equity` kind and nothing of that kind
 *     in it. The design's stock cards are Ondo Global Markets, which is a
 *     different product from the USDY treasury token we do list.
 *   - **Earnings.** No earnings calendar, and no source for one.
 *   - **News.** No feed.
 *   - **Most bought on Veil.** Needs usage analytics we do not collect.
 *
 * So they are absent rather than mocked. What is here is real: prices come from
 * Lens, the naira rate from Linq, pools from Blend, and the registry lists the
 * assets Veil will actually vouch for.
 *
 * The naira toggle is the part worth keeping even when the rest grows. A price
 * in dollars is a second conversion the user has to do in their head, and this
 * is a wallet whose point is that they should not have to.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { FlowHeader } from '../components/FlowHeader';
import { useTheme } from '../hooks/useTheme';
import { useNetwork } from '../hooks/useNetwork';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { ASSET_REGISTRY } from '../lib/assets';
import {
  AssetsIcon,
  BankIcon,
  EarnIcon,
  HexagonIcon,
  PoolsIcon,
  SwapVerticalIcon,
  YieldIcon,
  type IconProps,
} from '../components/icons';
import { fetchPrice } from '../lib/fetchPrice';
import { getOnrampRate } from '../lib/onramp';
import { loadBlendPools, type BlendPool } from '../lib/blend';

type Filter = 'all' | 'tokens' | 'earn' | 'apps';
type Currency = 'NGN' | 'USD';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'tokens', label: 'Tokens' },
  { key: 'earn', label: 'Earn' },
  { key: 'apps', label: 'Apps' },
];

/** The Stellar apps Veil opens. Mirrors the dApp directory. */
const APPS = [
  { key: 'blend', initials: 'B', name: 'Blend', hint: 'Lending · powers auto-earn' },
  { key: 'aquarius', initials: 'Aq', name: 'Aquarius', hint: 'AMM · liquidity rewards' },
  { key: 'soroswap', initials: 'So', name: 'Soroswap', hint: 'DEX aggregator' },
];

const LEARN = [
  { n: '01', title: 'Passkeys 101', hint: 'Why there is no seed phrase' },
  { n: '02', title: 'Where yield comes from', hint: 'How your USDC earns' },
  { n: '03', title: 'Shielded pools', hint: 'What “private” does and does not hide' },
];

type AssetKind = 'treasury' | 'fund' | 'equity' | 'stablecoin' | 'native';
type Market = {
  code: string;
  name: string;
  issuerName: string;
  kind: AssetKind;
  price: number | null;
};

/**
 * One mark per asset kind, from the existing icon set.
 *
 * Deliberately not issuer logos. A logo is a trademark and a remote fetch, and
 * the wrong one on a market row is worse than an honest glyph — particularly
 * here, where several Stellar issuers are actively impersonating real ones.
 */
const KIND_ICON: Record<AssetKind, (p: IconProps) => React.JSX.Element> = {
  native: HexagonIcon,
  stablecoin: AssetsIcon,
  treasury: BankIcon,
  fund: YieldIcon,
  equity: YieldIcon,
};

const APP_ICON: Record<string, (p: IconProps) => React.JSX.Element> = {
  blend: EarnIcon,
  aquarius: PoolsIcon,
  soroswap: SwapVerticalIcon,
};

export default function ExploreScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { networkName } = useNetwork();

  const [filter, setFilter] = useState<Filter>('all');
  const [currency, setCurrency] = useState<Currency>('NGN');
  const [query, setQuery] = useState('');

  const [markets, setMarkets] = useState<Market[]>([]);
  const [pools, setPools] = useState<BlendPool[]>([]);
  const [ngnRate, setNgnRate] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);

    // The registry is the list of assets Veil vouches for, so it is the list
    // worth showing. XLM is prepended because it is not in there — it is the
    // native asset, not an issued one.
    const entries = Object.values(ASSET_REGISTRY).filter(
      (a) => a.network === networkName || a.network === undefined,
    );

    const priced = await Promise.all(
      [
        {
          code: 'XLM',
          name: 'Stellar Lumens',
          issuerName: 'Native',
          kind: 'native' as AssetKind,
          issuer: null as string | null,
        },
        ...entries.map((a) => ({
          code: a.code,
          name: a.name,
          issuerName: a.issuerName,
          kind: a.kind as AssetKind,
          issuer: a.issuer as string | null,
        })),
      ].map(async (a) => ({
        code: a.code,
        name: a.name,
        issuerName: a.issuerName,
        kind: a.kind,
        // Best-effort by design: Lens 404s on a pair nobody trades, and a
        // missing price is shown as missing rather than guessed.
        price: await fetchPrice(a.code, a.issuer).catch(() => null),
      })),
    );
    setMarkets(priced);

    const [poolResult, rateResult] = await Promise.allSettled([
      loadBlendPools(),
      getOnrampRate(),
    ]);
    if (poolResult.status === 'fulfilled') setPools(poolResult.value);
    // Only shown when it resolves. A stale or invented rate is worse than none
    // on a screen whose job is to say what things cost.
    if (rateResult.status === 'fulfilled') setNgnRate(rateResult.value);
    else setNgnRate(null);

    setLoading(false);
  }, [networkName]);

  useEffect(() => {
    void load();
  }, [load]);

  const money = useCallback(
    (usd: number | null) => {
      if (usd === null) return '—';
      if (currency === 'USD') {
        return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: usd < 1 ? 4 : 2 })}`;
      }
      if (ngnRate === null) return '—';
      const ngn = usd * ngnRate;
      return `₦${ngn.toLocaleString('en-NG', { maximumFractionDigits: ngn < 100 ? 2 : 0 })}`;
    },
    [currency, ngnRate],
  );

  const q = query.trim().toLowerCase();
  const match = (...fields: string[]) => !q || fields.some((f) => f.toLowerCase().includes(q));

  const shownMarkets = markets.filter((m) => match(m.code, m.name, m.issuerName));
  const shownApps = APPS.filter((a) => match(a.name, a.hint));
  const shows = (section: Filter) => filter === 'all' || filter === section;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <FlowHeader title="Explore" />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.accent} />}
      >
        <View style={styles.searchRow}>
          <Text style={styles.searchGlyph}>⌕</Text>
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Search tokens, apps"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {/* Only offered when there is a rate behind it. */}
          {ngnRate !== null ? (
            <Pressable
              onPress={() => setCurrency((c) => (c === 'NGN' ? 'USD' : 'NGN'))}
              accessibilityRole="button"
              accessibilityLabel={`Show prices in ${currency === 'NGN' ? 'dollars' : 'naira'}`}
              style={({ pressed }) => [styles.currencyPill, pressed && styles.pressed]}
            >
              <Text style={styles.currencyText}>{currency === 'NGN' ? '₦' : '$'}</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={styles.chipRow}>
          {FILTERS.map((f) => (
            <Pressable
              key={f.key}
              onPress={() => setFilter(f.key)}
              style={[styles.chip, filter === f.key && styles.chipActive]}
            >
              <Text style={[styles.chipText, filter === f.key && styles.chipTextActive]}>
                {f.label}
              </Text>
            </Pressable>
          ))}
        </View>

        {loading && markets.length === 0 ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : null}

        {shows('tokens') && shownMarkets.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Markets</Text>
            <Text style={styles.sectionHint}>The assets Veil vouches for, pinned by issuer</Text>
            <View style={styles.card}>
              {shownMarkets.map((m, i) => (
                <View key={m.code} style={[styles.row, i > 0 && styles.rowDivided]}>
                  <View style={styles.rowAvatar}>
                    {(() => {
                      const Mark = KIND_ICON[m.kind] ?? AssetsIcon;
                      return <Mark size={18} color={colors.accent} />;
                    })()}
                  </View>
                  <View style={styles.rowText}>
                    <Text style={styles.rowLabel}>{m.code}</Text>
                    <Text style={styles.rowHint} numberOfLines={1}>
                      {m.name} · {m.issuerName}
                    </Text>
                  </View>
                  <Text style={styles.rowValue}>{money(m.price)}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {/* Stocks: announced, not listed.
            `AAPLon` and `NVDAon` do exist on Stellar mainnet, which is the
            trap. Every issuer of them fails the check this app already applies
            to every other asset: the real ondo.finance stellar.toml declares
            exactly one currency, USDY, and none of the stock issuers resolve to
            a domain Ondo controls. One of them, ondo.dtcc.markets, issues a
            counterfeit USDY alongside them under its own issuer.

            So there is nothing here to show yet. Listing them by code would be
            handing someone a forgery on a screen about what to buy. */}
        {shows('all') ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Stocks</Text>
            <View style={styles.card}>
              <View style={styles.row}>
                <View style={styles.rowAvatar}>
                  <YieldIcon size={18} color={colors.textMuted} />
                </View>
                <View style={styles.rowText}>
                  <View style={styles.soonLine}>
                    <Text style={styles.rowLabel}>Tokenised US stocks</Text>
                    <View style={styles.soonPill}>
                      <Text style={styles.soonText}>SOON</Text>
                    </View>
                  </View>
                  <Text style={styles.rowHint}>
                    Own a piece of Apple, paid for from your USDC balance. Viewing
                    and investing arrive together — not yet available on Stellar.
                  </Text>
                </View>
              </View>
            </View>
          </View>
        ) : null}

        {shows('earn') && pools.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Earn while you wait</Text>
            <Text style={styles.sectionHint}>Idle USDC earns by default</Text>
            <View style={styles.card}>
              {pools.map((p, i) => (
                <Pressable
                  key={p.id}
                  onPress={() => router.push('/earn')}
                  style={({ pressed }) => [styles.row, i > 0 && styles.rowDivided, pressed && styles.pressed]}
                >
                  <View style={styles.rowAvatar}>
                    <YieldIcon size={18} color={colors.accent} />
                  </View>
                  <View style={styles.rowText}>
                    <Text style={styles.rowLabel}>{p.name}</Text>
                    <Text style={styles.rowHint}>Blend pool</Text>
                  </View>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}

        {shows('apps') && shownApps.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Stellar apps</Text>
            <Text style={styles.sectionHint}>What Veil can open for you</Text>
            <View style={styles.card}>
              {shownApps.map((a, i) => (
                <Pressable
                  key={a.key}
                  onPress={() => router.push('/dapps')}
                  style={({ pressed }) => [styles.row, i > 0 && styles.rowDivided, pressed && styles.pressed]}
                >
                  <View style={styles.rowAvatar}>
                    {(() => {
                      const Mark = APP_ICON[a.key] ?? PoolsIcon;
                      return <Mark size={18} color={colors.accent} />;
                    })()}
                  </View>
                  <View style={styles.rowText}>
                    <Text style={styles.rowLabel}>{a.name}</Text>
                    <Text style={styles.rowHint}>{a.hint}</Text>
                  </View>
                  <Text style={styles.rowChevron}>↗</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}

        {shows('all') && ngnRate !== null ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Rates</Text>
            <Text style={styles.sectionHint}>What your dollars buy at home</Text>
            <View style={styles.card}>
              <View style={styles.row}>
                <View style={styles.rowAvatar}>
                  <Text style={styles.rowInitial}>₦</Text>
                </View>
                <View style={styles.rowText}>
                  <Text style={styles.rowLabel}>Nigerian naira</Text>
                  <Text style={styles.rowHint}>Live, from our payment partner</Text>
                </View>
                <Text style={styles.rowValue}>
                  {ngnRate.toLocaleString('en-NG', { maximumFractionDigits: 2 })} / $1
                </Text>
              </View>
            </View>
            {/* The design lists cedi and shilling too. One rate is live, so one
                rate is shown — the others would be decoration priced in a
                currency somebody might act on. */}
          </View>
        ) : null}

        {shows('all') ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Learn</Text>
            <View style={styles.card}>
              {LEARN.map((l, i) => (
                <View key={l.n} style={[styles.row, i > 0 && styles.rowDivided]}>
                  <Text style={styles.learnNum}>{l.n}</Text>
                  <View style={styles.rowText}>
                    <Text style={styles.rowLabel}>{l.title}</Text>
                    <Text style={styles.rowHint}>{l.hint}</Text>
                  </View>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        <Text style={styles.disclaimer}>
          Prices are best-effort from a third-party oracle and may lag. Veil does not
          offer investment advice.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    header: { paddingHorizontal: 20, paddingTop: 16 },
    body: { padding: 20, paddingBottom: 140, gap: 22 },

    searchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 14,
      paddingHorizontal: 14,
      paddingVertical: 4,
    },
    searchGlyph: { color: colors.textMuted, fontSize: 18 },
    searchInput: {
      flex: 1,
      color: colors.textPrimary,
      fontFamily: fontFamily.body,
      fontSize: 15,
      paddingVertical: 10,
    },
    currencyPill: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 999,
      backgroundColor: colors.surfaceMd,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    currencyText: { color: colors.accent, fontFamily: fontFamily.bodySemiBold, fontSize: 14 },

    chipRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
    chip: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    chipText: { color: colors.textMuted, fontFamily: fontFamily.bodyMedium, fontSize: 13 },
    chipTextActive: { color: colors.onAccent, fontFamily: fontFamily.bodySemiBold },

    loading: { paddingVertical: 32, alignItems: 'center' },

    section: { gap: 6 },
    sectionTitle: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 20 },
    sectionHint: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13, marginBottom: 4 },

    card: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 16,
      overflow: 'hidden',
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
    rowDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    rowAvatar: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceMd,
    },
    rowInitial: { color: colors.accent, fontFamily: fontFamily.accent, fontSize: 14 },
    rowText: { flex: 1, gap: 2 },
    rowLabel: { color: colors.textStrong, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },
    rowHint: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 12 },
    rowValue: { color: colors.textPrimary, fontFamily: fontFamily.address, fontSize: 14 },
    rowChevron: { color: colors.textMuted, fontSize: 16 },
    learnNum: { color: colors.textFaint, fontFamily: fontFamily.accent, fontSize: 14, width: 36 },

    disclaimer: {
      color: colors.textFaint,
      fontFamily: fontFamily.body,
      fontSize: 11,
      lineHeight: 17,
    },
    soonLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    soonPill: {
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surfaceMd,
    },
    soonText: {
      color: colors.textMuted,
      fontFamily: fontFamily.accent,
      fontSize: 9,
      letterSpacing: 0.8,
    },
    pressed: { opacity: 0.7 },
  });
