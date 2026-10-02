import React, { useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useActivityFeed, type TxRecord } from '../lib/activityFeed';
import { StellarIdenticon } from './StellarIdenticon';
import { knownDepositAddresses } from '../lib/offramp';
import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';

// ── Props ───────────────────────────────────────────────────────────────────

export type ActivityFilter = 'all' | 'transfers' | 'swaps' | 'sent' | 'received';

export interface ActivityFeedProps {
  /**
   * Which rows to show. 'transfers' is everything that is not a swap; 'sent'
   * and 'received' narrow that further and are what the tab bar uses.
   */
  filter?: ActivityFilter;
  /** Called when the user taps a transaction row */
  onSelectTx?: (tx: TxRecord) => void;
  /** Whether the feed is in a loading state (shows skeleton) */
  loading?: boolean;
  /** Message shown instead of the empty state when the fetch failed. */
  error?: string | null;
  /** Called when the user taps the refresh button */
  onRefresh?: () => void;
  /** Cap the number of rows shown (e.g. 3 on the dashboard preview). */
  limit?: number;
}


/** Truncate an address the way every Stellar explorer does. */
function shortAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-6)}` : value;
}

/**
 * Timestamps are stored in seconds (see activityFeed.ts), so they need scaling
 * before Date sees them — passing seconds straight in dates everything to 1970.
 *
 * Today shows a time and anything older shows a date: on the day it happened
 * "14:32" is what distinguishes two payments, and a month later the date is.
 */
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

// ── Component ───────────────────────────────────────────────────────────────

export default function ActivityFeed({
  filter = 'all',
  onSelectTx,
  loading = false,
  error = null,
  limit,
}: ActivityFeedProps) {
  const transactions = useActivityFeed();

  // Addresses we have cashed out to. An offramp is indistinguishable on chain
  // from any other USDC transfer — the naira leg is off-chain entirely — so
  // the only thing that can name it is our own record of where we sent it.
  const [depositAddresses, setDepositAddresses] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    void knownDepositAddresses().then((a) => {
      if (alive) setDepositAddresses(a);
    });
    return () => {
      alive = false;
    };
  }, []);
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const filtered = useMemo(() => {
    const base =
      filter === 'all'
        ? transactions
        : filter === 'swaps'
          ? transactions.filter((tx) => tx.type === 'swapped')
          : filter === 'sent'
            ? transactions.filter((tx) => tx.type === 'sent')
            : filter === 'received'
              ? transactions.filter((tx) => tx.type === 'received')
              : transactions.filter((tx) => tx.type !== 'swapped');
    return limit ? base.slice(0, limit) : base;
  }, [transactions, filter, limit]);

  const renderItem = ({ item, index }: { item: TxRecord; index: number }) => {
    const isLast = index === filtered.length - 1;
    const received = item.type === 'received';
    const swapped = item.type === 'swapped';
    const cashedOut = !received && depositAddresses.includes(item.counterparty);
    const label = cashedOut ? 'Cashed out' : swapped ? 'Swap' : received ? 'Received' : 'Sent';
    const when = formatWhen(item.timestamp);

    return (
      <TouchableOpacity
        activeOpacity={0.6}
        onPress={() => onSelectTx?.(item)}
        style={[styles.row, !isLast && styles.rowBorder]}
        accessibilityRole="button"
        // One spoken sentence rather than five fragments: a screen reader
        // otherwise reads the address character by character mid-row.
        accessibilityLabel={
          swapped
            ? `Swap, ${item.amount} ${item.asset} for ${item.destAmount} ${item.destAsset}, ${when}`
            : `${label} ${item.amount} ${item.asset}, ${received ? 'from' : 'to'} ${shortAddress(item.counterparty)}, ${when}`
        }
      >
        {/* Identity first: which address, not which verb. Most rows say "Sent",
            so leading with the action gives the eye nothing to sort on. */}
        <View style={styles.avatarWrap}>
          <StellarIdenticon address={item.counterparty} size={38} />
        </View>

        <View style={styles.rowLeft}>
          <Text style={styles.rowCounterparty} numberOfLines={1}>
            {shortAddress(item.counterparty)}
          </Text>
          <View style={styles.rowMetaLine}>
            <Text style={styles.rowLabel}>
              {cashedOut ? '🏦 ' : swapped ? '⇄ ' : received ? '↓ ' : '↑ '}
              {label}
            </Text>
            {item.memo ? <Text style={styles.rowMemo}>✉</Text> : null}
          </View>
        </View>

        <View style={styles.rowRight}>
          {swapped ? (
            <>
              <Text style={styles.rowAmount}>
                −{item.amount} {item.asset}
              </Text>
              <Text style={[styles.rowAmount, styles.rowAmountTeal]}>
                +{item.destAmount} {item.destAsset}
              </Text>
            </>
          ) : (
            <Text style={[styles.rowAmount, received && styles.rowAmountTeal]}>
              {received ? '+' : '−'}
              {item.amount} {item.asset}
            </Text>
          )}
          {when ? <Text style={styles.rowWhen}>{when}</Text> : null}
        </View>
      </TouchableOpacity>
    );
  };

  const renderEmpty = () => {
    if (loading) {
      return (
        <View style={styles.card}>
          {[1, 2, 3].map((i) => (
            <View
              key={i}
              style={[
                styles.skeletonRow,
                i < 3 && styles.rowBorder,
              ]}
            >
              <View style={styles.skeletonLeft}>
                <View style={styles.skeletonLineSmall} />
                <View style={styles.skeletonLineTiny} />
              </View>
              <View style={styles.skeletonLineMedium} />
            </View>
          ))}
        </View>
      );
    }

    // Distinct from the empty state on purpose: an unreachable indexer must not
    // read as "you have no transactions".
    if (error) {
      return (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>Couldn&apos;t load activity — {error}</Text>
        </View>
      );
    }

    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>
          {transactions.length === 0
            ? 'No transactions yet.'
            : filter === 'sent'
              ? 'Nothing sent yet.'
              : filter === 'received'
                ? 'Nothing received yet.'
                : filter === 'swaps'
                  ? 'No swaps yet.'
                  : 'Nothing here yet.'}
        </Text>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {filtered.length > 0 ? (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          scrollEnabled={false}
          contentContainerStyle={styles.card}
        />
      ) : (
        renderEmpty()
      )}
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      width: '100%',
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      overflow: 'hidden',
      // TEMP(layout preview): matched to AssetsList — one section keeping its
      // border while the other loses it reads as a bug, not a design.
    },
    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 14,
      paddingHorizontal: 16,
    },
    rowBorder: {
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    rowLeft: {
      flex: 1,
      marginRight: 12,
    },
    avatarWrap: {
      marginRight: 12,
      borderRadius: 8,
      overflow: 'hidden',
    },
    // The address now leads the row, so it carries the primary weight and the
    // action drops to a subtitle — the reverse of how this read before.
    rowCounterparty: {
      fontSize: 14,
      fontFamily: fontFamily.address,
      color: colors.textPrimary,
    },
    rowMetaLine: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginTop: 3,
    },
    rowLabel: {
      fontSize: 12,
      fontFamily: fontFamily.bodyMedium,
      color: colors.textFaint,
    },
    rowMemo: {
      fontSize: 11,
      color: colors.textFaint,
    },
    rowRight: {
      alignItems: 'flex-end',
    },
    rowAmount: {
      fontFamily: fontFamily.address,
      fontSize: 14,
      color: colors.textPrimary,
    },
    rowAmountTeal: {
      color: colors.positive,
      marginTop: 2,
    },
    rowWhen: {
      fontSize: 12,
      fontFamily: fontFamily.body,
      color: colors.textFaint,
      marginTop: 3,
    },
    // Skeleton
    skeletonRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 14,
      paddingHorizontal: 16,
    },
    skeletonLeft: {
      gap: 4,
    },
    skeletonLineSmall: {
      width: 48,
      height: 12,
      borderRadius: 4,
      backgroundColor: colors.surfaceMd,
    },
    skeletonLineTiny: {
      width: 96,
      height: 10,
      borderRadius: 4,
      backgroundColor: colors.surface,
    },
    skeletonLineMedium: {
      width: 72,
      height: 14,
      borderRadius: 4,
      backgroundColor: colors.surfaceMd,
    },
    // Empty state
    emptyContainer: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 32,
      alignItems: 'center',
    },
    emptyText: {
      fontSize: 14,
      color: colors.textFaint,
      textAlign: 'center',
    },
  });