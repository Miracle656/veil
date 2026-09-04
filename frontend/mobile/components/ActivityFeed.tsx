import React, { useMemo } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useActivityFeed, type TxRecord } from '../lib/activityFeed';
import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';

// ── Props ───────────────────────────────────────────────────────────────────

export interface ActivityFeedProps {
  /** Optional filter to show only specific types */
  filter?: 'all' | 'transfers' | 'swaps';
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

// ── Component ───────────────────────────────────────────────────────────────

export default function ActivityFeed({
  filter = 'all',
  onSelectTx,
  loading = false,
  error = null,
  limit,
}: ActivityFeedProps) {
  const transactions = useActivityFeed();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const filtered = useMemo(() => {
    const base =
      filter === 'all'
        ? transactions
        : filter === 'swaps'
          ? transactions.filter((tx) => tx.type === 'swapped')
          : transactions.filter((tx) => tx.type !== 'swapped');
    return limit ? base.slice(0, limit) : base;
  }, [transactions, filter, limit]);

  const renderItem = ({ item, index }: { item: TxRecord; index: number }) => {
    const isLast = index === filtered.length - 1;

    return (
      <TouchableOpacity
        activeOpacity={0.6}
        onPress={() => onSelectTx?.(item)}
        style={[styles.row, !isLast && styles.rowBorder]}
      >
        <View style={styles.rowLeft}>
          <Text style={styles.rowLabel}>
            {item.type === 'sent'
              ? '↑ Sent'
              : item.type === 'swapped'
              ? '⇄ Swap'
              : '↓ Received'}
          </Text>
          <Text style={styles.rowCounterparty}>
            {item.counterparty.length > 12
              ? `${item.counterparty.slice(0, 6)}…${item.counterparty.slice(-6)}`
              : item.counterparty}
          </Text>
        </View>

        <View style={styles.rowRight}>
          {item.type === 'swapped' ? (
            <>
              <Text style={styles.rowAmount}>
                -{item.amount} {item.asset}
              </Text>
              <Text style={[styles.rowAmount, styles.rowAmountTeal]}>
                +{item.destAmount} {item.destAsset}
              </Text>
            </>
          ) : (
            <Text style={styles.rowAmount}>
              {item.amount} {item.asset}
            </Text>
          )}
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
            : `No ${filter} found.`}
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
      borderWidth: 1,
      borderColor: colors.border,
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
    rowLabel: {
      fontSize: 14,
      fontFamily: fontFamily.bodyMedium,
      color: colors.textPrimary,
    },
    rowCounterparty: {
      fontSize: 12,
      color: colors.textFaint,
      marginTop: 2,
      fontFamily: fontFamily.address,
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
      borderWidth: 1,
      borderColor: colors.border,
    },
    emptyText: {
      fontSize: 14,
      color: colors.textFaint,
      textAlign: 'center',
    },
  });