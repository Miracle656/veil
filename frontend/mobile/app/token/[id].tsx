import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

import { ScreenScaffold } from '@/components/ScreenScaffold';
import { truncateAddress } from '../../components/ui/AddressChip';
import { useTheme } from '../../hooks/useTheme';
import type { ThemeColors } from '../../lib/theme';
import { fetchPrice } from '../../lib/price';
import {
  fetchTokenDetail,
  loadWalletAddress,
  parseAssetId,
  type TokenActivity,
  type TokenDetail,
} from '../../lib/token';

export default function TokenDetailScreen() {
  const { colors: themeColors } = useTheme();
  const styles = useMemo(() => createStyles(themeColors), [themeColors]);

  const { id } = useLocalSearchParams<{ id: string }>();
  const asset = useMemo(() => parseAssetId(id ?? 'XLM'), [id]);

  const [detail, setDetail] = useState<TokenDetail | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const address = await loadWalletAddress();
      if (!address) {
        setDetail(null);
        return;
      }
      const [d, p] = await Promise.all([
        fetchTokenDetail(address, asset.code, asset.issuer),
        fetchPrice(asset.code, asset.issuer),
      ]);
      setDetail(d);
      setPrice(p);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [asset.code, asset.issuer]);

  useEffect(() => {
    void load();
  }, [load]);

  const value =
    detail && price !== null ? (parseFloat(detail.balance) * price).toFixed(2) : null;

  return (
    <ScreenScaffold
      eyebrow="Token"
      title={asset.code}
      description={
        asset.issuer
          ? `Issuer: ${truncateAddress(asset.issuer, 8, 8)}`
          : 'Native asset'
      }
      backHref="/dashboard"
      backLabel="Dashboard"
    >
      {loading ? (
        <ActivityIndicator color={themeColors.accent} style={styles.spinner} />
      ) : !detail ? (
        <Text style={styles.muted}>No wallet found on this device yet.</Text>
      ) : (
        <>
          <View style={styles.balanceCard}>
            <Text style={styles.balanceLabel}>Balance</Text>
            <Text style={styles.balanceValue}>
              {detail.balance} {asset.code}
            </Text>
            <Text style={styles.price}>
              {price !== null
                ? `≈ $${value} · $${price.toFixed(price < 1 ? 6 : 2)}/${asset.code}`
                : 'Price unavailable'}
            </Text>
          </View>

          {error && <Text style={styles.error}>{error}</Text>}

          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Transfers</Text>
          </View>
          {detail.activity.length > 0 ? (
            <View style={styles.list}>
              {detail.activity.map((record) => (
                <TransferRow key={record.id} record={record} styles={styles} />
              ))}
            </View>
          ) : (
            <Text style={styles.muted}>No transfers for this asset yet.</Text>
          )}
        </>
      )}
    </ScreenScaffold>
  );
}

function TransferRow({
  record,
  styles,
}: {
  record: TokenActivity;
  styles: ReturnType<typeof createStyles>;
}) {
  const received = record.direction === 'received';
  return (
    <View style={styles.row}>
      <View style={styles.rowLeft}>
        <Text style={styles.rowType}>{received ? 'Received' : 'Sent'}</Text>
        <Text style={styles.rowParty} numberOfLines={1}>
          {received ? 'from' : 'to'} {truncateAddress(record.counterparty, 6, 6)}
        </Text>
      </View>
      <Text style={[styles.rowAmount, received ? styles.amountIn : styles.amountOut]}>
        {received ? '+' : '−'}
        {record.amount}
      </Text>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    spinner: {
      marginTop: 24,
    },
    balanceCard: {
      backgroundColor: colors.surface,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 20,
      gap: 6,
      marginTop: 8,
    },
    balanceLabel: {
      color: colors.textMuted,
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 1.6,
      textTransform: 'uppercase',
    },
    balanceValue: {
      color: colors.textStrong,
      fontSize: 26,
      fontWeight: '700',
    },
    price: {
      color: colors.textSecondary,
      fontSize: 13,
    },
    sectionHeader: {
      marginTop: 16,
      marginBottom: 8,
    },
    sectionTitle: {
      color: colors.textStrong,
      fontSize: 17,
      fontWeight: '600',
    },
    list: {
      gap: 8,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      backgroundColor: colors.surface,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 14,
    },
    rowLeft: {
      flexShrink: 1,
      gap: 2,
    },
    rowType: {
      color: colors.textStrong,
      fontSize: 15,
      fontWeight: '600',
    },
    rowParty: {
      color: colors.textMuted,
      fontSize: 12,
      fontFamily: 'monospace',
    },
    rowAmount: {
      fontSize: 14,
      fontWeight: '600',
      textAlign: 'right',
    },
    amountIn: {
      color: colors.accentText,
    },
    amountOut: {
      color: colors.textPrimary,
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
