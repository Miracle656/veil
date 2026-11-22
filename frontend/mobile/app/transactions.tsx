import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StrKey } from '@stellar/stellar-sdk';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { FlowHeader } from '../components/FlowHeader';
import ActivityFeed, { type ActivityFilter } from '../components/ActivityFeed';
import { TxDetailSheet } from '../components/TxDetailSheet';
import { hydrateActivityFeed, type TxRecord } from '../lib/activityFeed';
import { loadHorizonActivityPage } from '../lib/horizonActivity';
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
  // 'error' keeps the control on screen as a retry; the rows already loaded
  // are never touched by a failed page.
  const [older, setOlder] = useState<'idle' | 'loading' | 'error'>('idle');
  const [hasOlder, setHasOlder] = useState(false);
  const [isContractWallet, setIsContractWallet] = useState(false);
  const addressRef = useRef<string | null>(null);
  const cursorRef = useRef<string | null>(null);
  const detailSheetRef = useRef<BottomSheetModal>(null);

  const handleSelectTx = useCallback((tx: TxRecord) => {
    setSelectedTx(tx);
    detailSheetRef.current?.present();
  }, []);

  const load = useCallback(async () => {
    const addr = await getWalletAddress().catch(() => null);
    if (addr) {
      addressRef.current = addr;
      setIsContractWallet(StrKey.isValidContract(addr));
      // A refresh starts a new history: never let a cursor from a previous
      // wallet (or a previous page) outlive the rows it was derived from.
      cursorRef.current = null;
      setHasOlder(false);
      try {
        const page = await loadHorizonActivityPage(addr, 100);
        hydrateActivityFeed(page.records);
        // The token of the oldest operation loaded, so "Load older" continues
        // exactly where this page stopped.
        cursorRef.current = page.nextCursor;
        setHasOlder(!!page.nextCursor);
        setOlder('idle');
      } catch {
        // keep whatever is in the store
      }
    }
    setLoading(false);
  }, []);

  /**
   * Append the next older Horizon page. Merging rather than replacing is what
   * keeps the rows already on screen put; `movementKey` inside the feed makes
   * an operation that arrived twice land as one row.
   */
  const loadOlder = useCallback(async () => {
    const addr = addressRef.current;
    const cursor = cursorRef.current;
    if (!addr || !cursor || older === 'loading') return;
    setOlder('loading');
    try {
      const page = await loadHorizonActivityPage(addr, 100, cursor);
      if (page.records.length > 0) hydrateActivityFeed(page.records, { merge: true });
      cursorRef.current = page.nextCursor;
      // An empty page means Horizon has nothing older: the control goes away.
      setHasOlder(!!page.nextCursor);
      setOlder('idle');
    } catch {
      // A failed page keeps the rows already loaded and offers a retry, rather
      // than ending the history early or emptying the feed.
      setOlder('error');
    }
  }, [older]);

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

        {/* End of the list, below the rows — never in the tab row above. */}
        {older === 'error' ? (
          <View style={styles.olderBox}>
            <Text style={styles.olderError}>Couldn't load older transactions.</Text>
            <Pressable
              onPress={() => void loadOlder()}
              accessibilityRole="button"
              style={styles.olderButton}
              testID="retry-older"
            >
              <Text style={styles.olderLabel}>Retry</Text>
            </Pressable>
          </View>
        ) : hasOlder ? (
          <Pressable
            onPress={() => void loadOlder()}
            disabled={older === 'loading'}
            accessibilityRole="button"
            accessibilityState={{ disabled: older === 'loading' }}
            style={styles.olderButton}
            testID="load-older"
          >
            <Text style={styles.olderLabel}>{older === 'loading' ? 'Loading\u2026' : 'Load older'}</Text>
          </Pressable>
        ) : null}

        {isContractWallet ? (
          <Text style={styles.olderNote}>
            Transfers sent straight to this smart wallet by someone else are kept by the network for
            a short time, so older ones may be missing here.
          </Text>
        ) : null}
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
    olderButton: {
      marginTop: 8,
      alignSelf: 'center',
      paddingHorizontal: 18,
      paddingVertical: 10,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    olderLabel: { color: colors.textMuted, fontSize: 13 },
    olderBox: { marginTop: 8, alignItems: 'center', gap: 8 },
    olderError: { color: colors.textMuted, fontSize: 13, textAlign: 'center' },
    olderNote: { marginTop: 16, color: colors.textMuted, fontSize: 12, textAlign: 'center' },
    // On the gold pill the label has to flip to the on-accent ink, or it is
    // gold-on-gold and vanishes when selected.
    tabLabelActive: { color: colors.onAccent },
  });
