import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';

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
import { loadHorizonActivity } from '../../lib/horizonActivity';
import type { TxRecord } from '../../lib/activityFeed';
import { fetchTokenDetail, parseAssetId, type TokenActivity, type TokenDetail } from '../../lib/token';
import { getWalletAddress } from '../../lib/walletStore';
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
            <Text style={styles.section}>Activity</Text>
            {detail && detail.activity.length > 0 ? (
              <View style={styles.card}>
                {detail.activity.map((r, i) => (
                  <TransferRow key={r.id} record={r} styles={styles} last={i === detail.activity.length - 1} />
                ))}
              </View>
            ) : (
              <View style={styles.card}>
                <Text style={styles.empty}>No {asset.code} transfers yet.</Text>
              </View>
            )}
          </>
        )}
      </ScrollView>
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
}: {
  record: TokenActivity;
  styles: ReturnType<typeof createStyles>;
  last: boolean;
}) {
  const received = record.direction === 'received';
  // Same shape as the dashboard feed: identicon, address first, action beneath,
  // amount over date. Three different transaction rows in one app taught the
  // user three different layouts for the same information.
  const when = formatWhen(record.timestamp);
  return (
    <View style={[styles.row, !last && styles.rowBorder]}>
      <View style={styles.rowAvatar}>
        <StellarIdenticon address={record.counterparty} size={34} />
      </View>
      <View style={styles.rowLeft}>
        <Text style={styles.rowParty} numberOfLines={1}>
          {truncateAddress(record.counterparty, 6, 6)}
        </Text>
        <Text style={styles.rowType}>
          {received ? '↓ Received' : '↑ Sent'}
        </Text>
      </View>
      <View style={styles.rowRight}>
        <Text style={[styles.rowAmount, received ? styles.amountIn : styles.amountOut]}>
          {received ? '+' : '−'}
          {fmtAmount(record.amount)}
        </Text>
        {when ? <Text style={styles.rowWhen}>{when}</Text> : null}
      </View>
    </View>
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
