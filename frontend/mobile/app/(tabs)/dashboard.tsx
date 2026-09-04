import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';

import { colors } from '@/components/ScreenScaffold';
import { FirstRunTutorial } from '../../components/OnboardingTutorial';
import { TxDetailSheet } from '../../components/TxDetailSheet';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { VeilLogo } from '../../components/VeilLogo';
import { SilverBalanceCard } from '../../components/SilverBalanceCard';
import { PayForGrid } from '../../components/PayForGrid';
import { ServicesDrawer } from '../../components/ServicesDrawer';
import { AssetsList } from '../../components/AssetsList';
import { fontFamily } from '../../theme/typography';
import { useTheme } from '../../hooks/useTheme';
import type { ThemeColors } from '../../lib/theme';
import { getWalletAddress } from '../../lib/walletStore';
import ActivityFeed from '../../components/ActivityFeed';
import { useInitActivityFeed, hydrateActivityFeed, type TxRecord } from '../../lib/activityFeed';
import { loadHorizonActivity } from '../../lib/horizonActivity';
import { usePolling } from '../../hooks/usePolling';
import { fetchDashboardData } from '../../lib/activity';
import { fetchPrice, usdValue } from '../../lib/fetchPrice';
import { getNetwork } from '../../lib/network';
import { ensureBreadcrumbs } from '../../lib/walletBreadcrumbs';
import { ensureCorrectWalletAddress } from '../../lib/walletRepair';

/** Shorten a Stellar address for the header chip: `GDKF…9QX3`. */
function shortAddress(addr: string): string {
  return addr.length > 8 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

const WRAITH_URL =
  process.env.EXPO_PUBLIC_WRAITH_URL?.replace(/\/+$/, '') ?? null;

// Last-known balance/price survive remounts (e.g. returning from the lock
// screen), so the card paints instantly instead of flashing a loading state.
// Scoped to the wallet ADDRESS: after a reset/new wallet the old figures must
// never paint under the new address.
const lastKnown: { address: string | null; balance: string; price: number | null } = {
  address: null,
  balance: '—',
  price: null,
};

/**
 * Dashboard tab — primary destination after unlock.
 *
 * Shows the wallet balance, quick actions, and a live activity feed
 * sourced from the Wraith indexer.
 */
export default function DashboardTab() {
  const router = useRouter();
  const { colors: themeColors } = useTheme();
  const themedStyles = useMemo(() => createThemedStyles(themeColors), [themeColors]);
  const [servicesOpen, setServicesOpen] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [balance, setBalance] = useState<string>(() => lastKnown.balance);
  const [price, setPrice] = useState<number | null>(() => lastKnown.price);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedTx, setSelectedTx] = useState<TxRecord | null>(null);
  const detailSheetRef = useRef<BottomSheetModal>(null);

  const handleSelectTx = useCallback((tx: TxRecord) => {
    setSelectedTx(tx);
    detailSheetRef.current?.present();
  }, []);

  const onTestnet = getNetwork().name === 'testnet';

  // Refetch balance + price and rebuild the activity feed from Horizon + SAC
  // events — on EVERY network (Wraith, when configured, only supplements).
  const refreshAll = useCallback(
    async (addr: string) => {
      try {
        const [data, p] = await Promise.all([fetchDashboardData(addr), fetchPrice('XLM', null)]);
        lastKnown.balance = data.xlmBalance;
        lastKnown.price = p;
        setBalance(data.xlmBalance);
        setPrice(p);
      } catch {
        // keep the last-known values
      }
      try {
        // Merge, don't replace: this runs every 15s, and any single source
        // blinking (rate-limited RPC, slow Horizon page) would otherwise blank
        // the feed until the next poll refilled it.
        hydrateActivityFeed(await loadHorizonActivity(addr), { merge: true });
      } catch {
        // activity stays as-is
      }
    },
    [],
  );

  // Load the wallet address (repairing a wrong-network derivation first),
  // then its balance / price / activity on mount.
  useEffect(() => {
    ensureCorrectWalletAddress()
      .then((addr) => {
        setWalletAddress(addr);
        if (addr) {
          // Different wallet than the cached one (reset / fresh create / login):
          // drop every carried-over figure before fetching, so the new wallet
          // never paints the old wallet's data.
          if (lastKnown.address !== addr) {
            lastKnown.address = addr;
            lastKnown.balance = '—';
            lastKnown.price = null;
            setBalance('—');
            setPrice(null);
            hydrateActivityFeed([]);
          }
          void refreshAll(addr);
          // Backfill the on-chain sign-in record for wallets created before
          // breadcrumbs existed (idempotent, once per session, best-effort).
          void ensureBreadcrumbs();
        }
      })
      .catch(() => setWalletAddress(null));
  }, [refreshAll]);

  // Wraith feed init — skipped on testnet (Horizon covers it in refreshAll).
  const { loading, error, refresh: refreshFeed } = useInitActivityFeed(
    walletAddress,
    onTestnet ? null : WRAITH_URL,
  );

  // Refresh whenever the tab regains focus (e.g. returning from a send/swap).
  useFocusEffect(
    useCallback(() => {
      if (walletAddress) void refreshAll(walletAddress);
    }, [walletAddress, refreshAll]),
  );

  // Background polling every 15s.
  usePolling(
    async () => {
      if (walletAddress) await refreshAll(walletAddress);
    },
    15_000,
    !!walletAddress,
  );

  // Pull-to-refresh.
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    if (walletAddress) {
      await refreshAll(walletAddress);
      if (!onTestnet) await refreshFeed().catch(() => undefined);
    }
    setRefreshing(false);
  }, [walletAddress, refreshAll, refreshFeed, onTestnet]);

  const usd = useMemo(() => usdValue(balance, price), [balance, price]);

  return (
    <SafeAreaView style={themedStyles.screen} edges={['top']} testID="dashboard-screen">
      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={themedStyles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={themeColors.accent}
          />
        }
      >
      {/* Header — Drape logo + wordmark, and the wallet address chip */}
      <View style={themedStyles.homeHeader}>
        <Pressable
          onPress={() => setServicesOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Open services menu"
          hitSlop={10}
          style={({ pressed }) => [themedStyles.brand, pressed && { opacity: 0.6 }]}
        >
          <VeilLogo size={22} color={themeColors.accent} />
          <Text style={themedStyles.wordmark}>VEIL</Text>
        </Pressable>
        {walletAddress ? (
          <View style={themedStyles.addrChip}>
            <Text style={themedStyles.addrText}>{shortAddress(walletAddress)}</Text>
          </View>
        ) : null}
      </View>

      <SilverBalanceCard
        balance={balance === '—' ? undefined : balance}
        usd={usd}
        loading={balance === '—' && loading}
        error={!!error}
      />

      <PayForGrid onMore={() => setServicesOpen(true)} />

      <ServicesDrawer visible={servicesOpen} onClose={() => setServicesOpen(false)} />

      <AssetsList
        address={walletAddress}
        fallbackXlm={balance === '—' ? null : balance}
        fallbackUsd={usd}
      />

      {/* Activity feed — 3 most recent, full history on the transactions page */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Activity</Text>
        <Pressable onPress={() => router.push('/transactions')} hitSlop={8} accessibilityRole="button">
          <Text style={styles.sectionLink}>See all →</Text>
        </Pressable>
      </View>
      <ActivityFeed filter="all" loading={loading} error={error} onSelectTx={handleSelectTx} limit={3} />

      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {/* Shows once per install; self-gates on the persisted flag. */}
      <FirstRunTutorial />

      {/* Opened by tapping a row in the activity feed. */}
      <TxDetailSheet ref={detailSheetRef} tx={selectedTx} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  sectionTitle: {
    color: colors.gold,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  sectionHint: {
    color: colors.muted,
    fontSize: 11,
  },
  sectionLink: {
    color: colors.gold,
    fontSize: 12,
    fontFamily: fontFamily.bodyMedium,
  },
  grid: {
    gap: 8,
  },
  errorBanner: {
    backgroundColor: 'rgba(255, 107, 107, 0.1)',
    borderColor: 'rgba(255, 107, 107, 0.3)',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
  },
  errorText: {
    color: '#FF6B6B',
    fontSize: 13,
    textAlign: 'center',
  },
});

const createThemedStyles = (themeColors: ThemeColors) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: themeColors.background,
    },
    scrollContent: {
      paddingHorizontal: 20,
      paddingTop: 12,
      // Extra bottom room so the floating VeilTabBar never covers the last row.
      paddingBottom: 140,
      // Breathing room between the card, Pay-for, Assets, and Activity.
      gap: 22,
    },
    homeHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 4,
      marginBottom: 6,
    },
    brand: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    wordmark: {
      fontFamily: fontFamily.accent,
      fontSize: 15,
      letterSpacing: 1.2,
      color: themeColors.accent,
    },
    addrChip: {
      borderWidth: 1,
      borderColor: 'rgba(253,218,36,0.18)',
      backgroundColor: 'rgba(253,218,36,0.08)',
      borderRadius: 999,
      paddingHorizontal: 14,
      paddingVertical: 5,
    },
    addrText: {
      fontFamily: fontFamily.address,
      fontSize: 13,
      color: themeColors.accent,
    },
    connectButton: {
      alignSelf: 'flex-start',
      backgroundColor: themeColors.accent,
      borderRadius: 999,
      paddingVertical: 12,
      paddingHorizontal: 28,
    },
    pressed: {
      opacity: 0.75,
    },
    connectLabel: {
      color: themeColors.onAccent,
      fontSize: 15,
      fontWeight: '700',
    },
    sessions: {
      alignSelf: 'stretch',
      gap: 8,
    },
    sessionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      borderWidth: 1,
      borderColor: themeColors.border,
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 12,
    },
    sessionName: {
      color: themeColors.textPrimary,
      fontSize: 14,
      flexShrink: 1,
    },
    disconnect: {
      color: themeColors.accentText,
      fontSize: 13,
      fontWeight: '600',
    },
  });