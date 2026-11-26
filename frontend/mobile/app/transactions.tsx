import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { FlowHeader } from '../components/FlowHeader';
import ActivityFeed, { type ActivityFilter } from '../components/ActivityFeed';
import { TxDetailSheet } from '../components/TxDetailSheet';
import { hydrateActivityFeed, type TxRecord } from '../lib/activityFeed';
import { loadHorizonActivity } from '../lib/horizonActivity';
import { getWalletAddress } from '../lib/walletStore';
import { getNetwork } from '../lib/network';

/**
 * Full transaction history — the "See all" destination from the dashboard's
 * 3-row Activity preview. On testnet it (re)loads straight from Horizon; on
 * mainnet it shows the shared store already populated by Wraith.
 */
const TABS: { key: ActivityFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'sent', label: 'Sent' },
  { key: 'received', label: 'Received' },
  { key: 'swaps', label: 'Swaps' },
];

export default function TransactionsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedTx, setSelectedTx] = useState<TxRecord | null>(null);
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const detailSheetRef = useRef<BottomSheetModal>(null);

  const handleSelectTx = useCallback((tx: TxRecord) => {
    setSelectedTx(tx);
    detailSheetRef.current?.present();
  }, []);

  const load = useCallback(async () => {
    const addr = await getWalletAddress().catch(() => null);
    if (addr) {
      try {
        hydrateActivityFeed(await loadHorizonActivity(addr, 100));
      } catch {
        // keep whatever is in the store
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="transactions-screen">
      <View style={styles.header}>
        <FlowHeader title="Transactions" />
      </View>
      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
      >
        {/* Filter tabs, the way every explorer and wallet presents a history.
            Kept above the scrolling list rather than inside it so the selected
            filter stays visible while paging through a long history. */}
        <View style={styles.tabs}>
          {TABS.map((tab) => {
            const active = filter === tab.key;
            return (
              <Pressable
                key={tab.key}
                onPress={() => setFilter(tab.key)}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                style={[styles.tab, active && styles.tabActive]}
              >
                <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>
                  {tab.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <ActivityFeed filter={filter} loading={loading} onSelectTx={handleSelectTx} />
      </ScrollView>

      {/* Opened by tapping a row in the activity feed. */}
      <TxDetailSheet ref={detailSheetRef} tx={selectedTx} />
    </SafeAreaView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    header: { paddingHorizontal: 24, paddingTop: 16 },
    body: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 40 },
    tabs: { flexDirection: 'row', gap: 8, marginBottom: 16 },
    tab: {
      paddingHorizontal: 14,
      paddingVertical: 7,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    tabActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    tabLabel: { color: colors.textMuted, fontSize: 13 },
    // On the gold pill the label has to flip to the on-accent ink, or it is
    // gold-on-gold and vanishes when selected.
    tabLabelActive: { color: colors.onAccent },
  });
