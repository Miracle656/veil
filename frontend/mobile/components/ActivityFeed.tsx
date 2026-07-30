import React, { useMemo } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useActivityFeed, type TxRecord } from '../lib/activityFeed';

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
}

// ── Color constants (matching Veil dark theme) ──────────────────────────────

const COLORS = {
  background: '#0B0B0F',
  card: '#131317',
  border: 'rgba(246,247,248,0.08)',
  gold: '#FDDA24',
  goldDim: 'rgba(253,218,36,0.35)',
  offWhite: '#F6F7F8',
  muted: 'rgba(246,247,248,0.4)',
  warmGrey: '#9BA1A6',
  teal: '#4DB6AC',
  nearBlack: '#0E0E12',
};

// ── Component ───────────────────────────────────────────────────────────────

export default function ActivityFeed({
  filter = 'all',
  onSelectTx,
  loading = false,
  error = null,
}: ActivityFeedProps) {
  const transactions = useActivityFeed();

  const filtered = useMemo(() => {
    if (filter === 'all') return transactions;
    if (filter === 'swaps')
      return transactions.filter((tx) => tx.type === 'swapped');
    return transactions.filter((tx) => tx.type !== 'swapped');
  }, [transactions, filter]);

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

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  card: {
    backgroundColor: COLORS.card,
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: COLORS.border,
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
    borderBottomColor: COLORS.border,
  },
  rowLeft: {
    flex: 1,
    marginRight: 12,
  },
  rowLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: COLORS.offWhite,
  },
  rowCounterparty: {
    fontSize: 12,
    color: COLORS.muted,
    marginTop: 2,
    fontFamily: 'monospace',
  },
  rowRight: {
    alignItems: 'flex-end',
  },
  rowAmount: {
    fontFamily: 'monospace',
    fontSize: 14,
    color: COLORS.offWhite,
  },
  rowAmountTeal: {
    color: COLORS.teal,
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
    backgroundColor: 'rgba(246,247,248,0.06)',
  },
  skeletonLineTiny: {
    width: 96,
    height: 10,
    borderRadius: 4,
    backgroundColor: 'rgba(246,247,248,0.04)',
  },
  skeletonLineMedium: {
    width: 72,
    height: 14,
    borderRadius: 4,
    backgroundColor: 'rgba(246,247,248,0.06)',
  },
  // Empty state
  emptyContainer: {
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: 32,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  emptyText: {
    fontSize: 14,
    color: COLORS.muted,
    textAlign: 'center',
  },
});