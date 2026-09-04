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

import { fetchPrice } from '../../lib/price';
import { fetchTokenDetail, parseAssetId, type TokenActivity, type TokenDetail } from '../../lib/token';
import { getWalletAddress } from '../../lib/walletStore';
import { fetchContractXlm, getFeePayerAddress } from '../../lib/activity';

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
      const [d, p, extraXlm] = await Promise.all([
        effective
          ? fetchTokenDetail(effective, asset.code, asset.issuer)
          : Promise.resolve({ code: asset.code, issuer: asset.issuer, balance: '0', activity: [] as TokenActivity[] }),
        fetchPrice(asset.code, asset.issuer),
        isContract && asset.code === 'XLM' ? fetchContractXlm(stored) : Promise.resolve(0),
      ]);
      setDetail(extraXlm > 0 ? { ...d, balance: (Number(d.balance) + extraXlm).toFixed(7) } : d);
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
  return (
    <View style={[styles.row, !last && styles.rowBorder]}>
      <View style={styles.rowLeft}>
        <Text style={styles.rowType}>{received ? 'Received' : 'Sent'}</Text>
        <Text style={styles.rowParty} numberOfLines={1}>
          {received ? 'from' : 'to'} {truncateAddress(record.counterparty, 6, 6)}
        </Text>
      </View>
      <Text style={[styles.rowAmount, received ? styles.amountIn : styles.amountOut]}>
        {received ? '+' : '−'}
        {fmtAmount(record.amount)}
      </Text>
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
    rowLeft: { flexShrink: 1, gap: 2 },
    rowType: { color: colors.textPrimary, fontFamily: fontFamily.bodyMedium, fontSize: 15 },
    rowParty: { color: colors.textFaint, fontFamily: fontFamily.address, fontSize: 12 },
    rowAmount: { fontFamily: fontFamily.address, fontSize: 14, textAlign: 'right' },
    amountIn: { color: colors.positive },
    amountOut: { color: colors.textPrimary },
    empty: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 14, padding: 16 },
    pressed: { opacity: 0.6 },
  });
