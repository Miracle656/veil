import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';

import { useTheme } from '../../hooks/useTheme';
import { useCurrency } from '../../hooks/useCurrency';
import { useHiddenAmounts } from '../../hooks/useHiddenAmounts';
import type { ThemeColors } from '../../lib/theme';
import { fontFamily } from '../../theme/typography';
import { FlowHeader } from '../../components/FlowHeader';
import { TokenIcon } from '../../components/TokenIcon';
import { PaperPlaneIcon, ReceiveIcon, SwapIcon, type IconProps } from '../../components/icons';
import { truncateAddress } from '../../components/ui/AddressChip';
import { StrKey } from '@stellar/stellar-sdk';

import { fetchPrice } from '../../lib/fetchPrice';
import { StellarIdenticon } from '../../components/StellarIdenticon';
import { TxDetailSheet } from '../../components/TxDetailSheet';
import { loadHorizonActivity } from '../../lib/horizonActivity';
import type { TxRecord } from '../../lib/activityFeed';
import { fetchTokenDetail, parseAssetId, type TokenActivity, type TokenDetail } from '../../lib/token';
import { getWalletAddress } from '../../lib/walletStore';
import { knownDepositAddresses } from '../../lib/offramp';
import { fetchContractAssetBalance, getFeePayerAddress } from '../../lib/activity';

const NAMES: Record<string, string> = { XLM: 'Stellar Lumens', USDC: 'USD Coin', EURC: 'Euro Coin' };

function fmtAmount(raw: string): string {
  const n = Number(raw);
  if (!isFinite(n)) return raw;
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

export default function TokenDetailScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { format } = useCurrency();
  const { mask } = useHiddenAmounts();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const { id } = useLocalSearchParams<{ id: string }>();
  const asset = useMemo(() => parseAssetId(id ?? 'XLM'), [id]);
  const name = NAMES[asset.code.toUpperCase()] ?? asset.code;

  const [detail, setDetail] = useState<TokenDetail | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const stored = await getWalletAddress();
      if (!stored) {
        setDetail(null);
        return;
      }
      // Smart wallets: classic history/trustlines live on the fee-payer, and
      // the contract's own XLM (via SAC) is folded into the XLM balance.
      const isContract = StrKey.isValidContract(stored);
      const effective = isContract ? await getFeePayerAddress() : stored;
      const [d, p, extraXlm, feed] = await Promise.all([
        effective
          ? fetchTokenDetail(effective, asset.code, asset.issuer)
          : Promise.resolve({ code: asset.code, issuer: asset.issuer, balance: '0', activity: [] as TokenActivity[] }),
        fetchPrice(asset.code, asset.issuer),
        // Any asset, not just XLM. The contract holds issued assets as SAC
        // storage entries, which the Horizon read above cannot see — it only
        // ever looks at the fee payer's trustlines. Restricting this to XLM
        // meant a token page reported the fee payer's share as the whole
        // balance while the dashboard, which does sum both, disagreed.
        isContract
          ? fetchContractAssetBalance(
              stored,
              asset.code === 'XLM' || !asset.issuer
                ? undefined
                : { code: asset.code, issuer: asset.issuer },
            )
          : Promise.resolve(0),
        // Classic payments alone cannot describe a smart wallet's history.
        // fetchTokenDetail asks Horizon for payments to the FEE PAYER, so a
        // transfer into the contract — an invoke_host_function on the asset's
        // SAC, addressed to a C-account — appears nowhere in it. That is why
        // this page listed September 4th and not a receipt from today.
        //
        // loadHorizonActivity already merges the classic side with the
        // contract's SAC events, so reuse it rather than teach a second module
        // the same lesson.
        loadHorizonActivity(stored, 50).catch(() => [] as TxRecord[]),
      ]);
      const merged = mergeActivity(d.activity, feed, asset.code);
      const withBalance =
        extraXlm > 0 ? { ...d, balance: (Number(d.balance) + extraXlm).toFixed(7) } : d;
      setDetail({ ...withBalance, activity: merged });
      setPrice(p);
    } catch {
      // leave last-known
    } finally {
      setLoading(false);
    }
  }, [asset.code, asset.issuer]);

  useEffect(() => {
    void load();
  }, [load]);

  const usd = detail && price !== null ? parseFloat(detail.balance) * price : null;

  const [filter, setFilter] = useState<'all' | 'sent' | 'received'>('all');
  const [depositAddresses, setDepositAddresses] = useState<string[]>([]);

  useEffect(() => {
    void knownDepositAddresses().then(setDepositAddresses).catch(() => {});
  }, []);

  const [selectedTx, setSelectedTx] = useState<TxRecord | null>(null);
  const detailSheetRef = useRef<BottomSheetModal>(null);

  const visibleActivity = (detail?.activity ?? []).filter((r) =>
    filter === 'all' ? true : r.direction === filter,
  );

  // TokenActivity is this page's shape; the detail sheet speaks TxRecord.
  // Mapped rather than widened, so the sheet keeps one input.
  const openDetail = (r: TokenActivity) => {
    setSelectedTx({
      id: r.id,
      type: r.direction,
      amount: r.amount,
      asset: asset.code,
      counterparty: r.counterparty,
      timestamp: r.timestamp,
      hash: r.hash,
    });
    detailSheetRef.current?.present();
  };

  const actions: Array<{ key: string; label: string; Icon: (p: IconProps) => React.JSX.Element; onPress: () => void }> = [
    { key: 'send', label: 'Send', Icon: PaperPlaneIcon, onPress: () => router.push(`/send?asset=${asset.code}`) },
    { key: 'receive', label: 'Receive', Icon: ReceiveIcon, onPress: () => router.push('/receive') },
    { key: 'swap', label: 'Swap', Icon: SwapIcon, onPress: () => router.push('/swap') },
  ];

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="token-screen">
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.body}>
        <FlowHeader title={name} />

        {loading && !detail ? (
          <ActivityIndicator color={colors.accent} style={{ marginTop: 40 }} />
        ) : (
          <>
            {/* Hero */}
            <View style={styles.hero}>
              <TokenIcon code={asset.code} size={60} />
              <Text style={styles.balance} numberOfLines={1} adjustsFontSizeToFit>
                {mask(fmtAmount(detail?.balance ?? '0'))} {asset.code}
              </Text>
              <Text style={styles.fiat}>
                {usd !== null ? `≈ ${mask(format(usd))}` : 'No price yet'}
                {price !== null ? `  ·  ${format(price)}/${asset.code}` : ''}
              </Text>
            </View>

            {/* Actions */}
            <View style={styles.actions}>
              {actions.map((a) => (
                <Pressable
                  key={a.key}
                  onPress={a.onPress}
                  accessibilityRole="button"
                  accessibilityLabel={a.label}
                  style={({ pressed }) => [styles.action, pressed && styles.pressed]}
                >
                  <a.Icon size={20} color={colors.accent} />
                  <Text style={styles.actionLabel}>{a.label}</Text>
                </Pressable>
              ))}
            </View>

            {/* Activity */}
            <View style={styles.activityHead}>
              <Text style={styles.section}>Activity</Text>
              {/* The same three filters /transactions has. A token page is
                  where someone goes to answer "what happened with this
                  asset", and that question is usually one direction. */}
              <View style={styles.filterRow}>
                {(['all', 'received', 'sent'] as const).map((f) => (
                  <Pressable
                    key={f}
                    onPress={() => setFilter(f)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: filter === f }}
                    style={[styles.filterPill, filter === f && styles.filterPillActive]}
                  >
                    <Text style={[styles.filterText, filter === f && styles.filterTextActive]}>
                      {f === 'all' ? 'All' : f === 'sent' ? 'Sent' : 'Received'}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
            {visibleActivity.length > 0 ? (
              <View style={styles.card}>
                {visibleActivity.map((r, i) => (
                  <TransferRow
                    key={r.id}
                    record={r}
                    styles={styles}
                    last={i === visibleActivity.length - 1}
                    onPress={() => openDetail(r)}
                    cashedOut={r.direction === 'sent' && depositAddresses.includes(r.counterparty)}
                  />
                ))}
              </View>
            ) : (
              <View style={styles.card}>
                {/* An empty filter is not an empty history — saying "no
                    transfers yet" over a wallet that has plenty, just none
                    in this direction, is the same absent-vs-none confusion
                    the balance screens had. */}
                <Text style={styles.empty}>
                  {filter === 'all'
                    ? `No ${asset.code} transfers yet.`
                    : `No ${filter} ${asset.code} transfers.`}
                </Text>
              </View>
            )}
          </>
        )}
      </ScrollView>

      {/* Opened by tapping a transfer row, same sheet the dashboard and the
          full history use. */}
      <TxDetailSheet ref={detailSheetRef} tx={selectedTx} />
    </SafeAreaView>
  );
}

/**
 * Fold the merged wallet feed into this token's classic history.
 *
 * The two sources overlap on classic payments, so dedupe by transaction hash
 * and let the classic row win — it is the richer description of the same
 * event. Rows without a hash cannot be matched, so they are kept.
 */
function mergeActivity(
  classic: TokenActivity[],
  feed: TxRecord[],
  code: string,
): TokenActivity[] {
  const seen = new Set(classic.map((a) => a.hash).filter(Boolean));
  const extra: TokenActivity[] = feed
    .filter((r) => r.asset === code && (!r.hash || !seen.has(r.hash)))
    .map((r) => ({
      id: r.id,
      direction: r.type === 'received' ? ('received' as const) : ('sent' as const),
      amount: r.amount.replace(/,/g, ''),
      counterparty: r.counterparty,
      timestamp: r.timestamp,
      hash: r.hash ?? '',
    }));
  return [...classic, ...extra].sort((a, b) => b.timestamp - a.timestamp);
}

/** Today shows a time; anything older shows a date. Timestamps are seconds. */
function formatWhen(seconds: number): string {
  const d = new Date(seconds * 1000);
  if (!Number.isFinite(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function TransferRow({
  record,
  styles,
  last,
  onPress,
  cashedOut,
}: {
  record: TokenActivity;
  styles: ReturnType<typeof createStyles>;
  last: boolean;
  onPress?: () => void;
  cashedOut?: boolean;
}) {
  const received = record.direction === 'received';
  // Same shape as the dashboard feed: identicon, address first, action beneath,
  // amount over date. Three different transaction rows in one app taught the
  // user three different layouts for the same information.
  const when = formatWhen(record.timestamp);
  return (
    // Tappable, like every other transaction row in the app. These looked
    // identical to the dashboard feed's rows and did nothing when pressed,
    // which reads as the app being broken rather than the row being inert.
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, !last && styles.rowBorder, pressed && styles.pressed]}
    >
      <View style={styles.rowAvatar}>
        <StellarIdenticon address={record.counterparty} size={34} />
      </View>
      <View style={styles.rowLeft}>
        <Text style={styles.rowParty} numberOfLines={1}>
          {truncateAddress(record.counterparty, 6, 6)}
        </Text>
        <Text style={styles.rowType}>
          {/* A cash-out is a send to Linq's deposit address. Left as "Sent"
              it looks like the user paid a stranger. */}
          {cashedOut ? '🏦 Cashed out' : received ? '↓ Received' : '↑ Sent'}
        </Text>
      </View>
      <View style={styles.rowRight}>
        <Text style={[styles.rowAmount, received ? styles.amountIn : styles.amountOut]}>
          {received ? '+' : '−'}
          {fmtAmount(record.amount)}
        </Text>
        {when ? <Text style={styles.rowWhen}>{when}</Text> : null}
      </View>
    </Pressable>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    body: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 40 },

    hero: { alignItems: 'center', gap: 12, marginTop: 24 },
    balance: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 40, marginTop: 6 },
    fiat: { color: colors.textMuted, fontFamily: fontFamily.address, fontSize: 13 },

    actions: { flexDirection: 'row', gap: 10, marginTop: 26 },
    action: {
      flex: 1,
      alignItems: 'center',
      gap: 7,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 16,
      paddingVertical: 16,
    },
    actionLabel: { color: colors.textPrimary, fontFamily: fontFamily.bodyMedium, fontSize: 13 },

    // The heading and its filters share a line; the filters sit on the
    // heading's baseline so the section keeps its existing top margin.
    activityHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    filterRow: { flexDirection: 'row', gap: 6, marginTop: 30, marginBottom: 10 },
    filterPill: {
      paddingHorizontal: 12,
      paddingVertical: 5,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    filterPillActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    filterText: { color: colors.textMuted, fontSize: 12 },
    // Gold-on-gold otherwise.
    filterTextActive: { color: colors.onAccent },

    section: {
      color: colors.textFaint,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 11,
      letterSpacing: 1.4,
      textTransform: 'uppercase',
      marginTop: 30,
      marginBottom: 10,
    },
    card: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 16,
      overflow: 'hidden',
    },
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: 16 },
    rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
    rowAvatar: { borderRadius: 8, overflow: 'hidden' },
    rowLeft: { flex: 1, gap: 3 },
    // Address leads, action follows — the reverse of before, matching the feed.
    rowParty: { color: colors.textPrimary, fontFamily: fontFamily.address, fontSize: 14 },
    rowType: { color: colors.textFaint, fontFamily: fontFamily.bodyMedium, fontSize: 12 },
    rowRight: { alignItems: 'flex-end', gap: 3 },
    rowWhen: { color: colors.textFaint, fontFamily: fontFamily.body, fontSize: 12 },
    rowAmount: { fontFamily: fontFamily.address, fontSize: 14, textAlign: 'right' },
    amountIn: { color: colors.positive },
    amountOut: { color: colors.textPrimary },
    empty: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 14, padding: 16 },
    pressed: { opacity: 0.6 },
  });
