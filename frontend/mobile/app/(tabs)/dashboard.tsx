import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ScreenScaffold, NavRow, colors } from '@/components/ScreenScaffold';
import { QuickActions } from '../../components/QuickActions';
import { FirstRunTutorial } from '../../components/OnboardingTutorial';
import { TxDetailSheet } from '../../components/TxDetailSheet';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { ConnectDAppModal } from '../../components/ConnectDAppModal';
import { ThemeToggle } from '../../components/ThemeToggle';
import { useWalletConnect } from '../../hooks/useWalletConnect';
import { useTheme } from '../../hooks/useTheme';
import type { ThemeColors } from '../../lib/theme';
import { getWalletAddress } from '../../lib/walletStore';
import ActivityFeed from '../../components/ActivityFeed';
import { useInitActivityFeed, type TxRecord } from '../../lib/activityFeed';

const WRAITH_URL =
  process.env.EXPO_PUBLIC_WRAITH_URL?.replace(/\/+$/, '') ?? null;

/**
 * Dashboard tab — primary destination after unlock.
 *
 * Shows the wallet balance, quick actions, and a live activity feed
 * sourced from the Wraith indexer.
 */
export default function DashboardTab() {
  const { colors: themeColors } = useTheme();
  const themedStyles = useMemo(() => createThemedStyles(themeColors), [themeColors]);
  const { sessions, disconnectSession } = useWalletConnect();
  const [isConnectOpen, setIsConnectOpen] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [selectedTx, setSelectedTx] = useState<TxRecord | null>(null);
  const detailSheetRef = useRef<BottomSheetModal>(null);

  const handleSelectTx = useCallback((tx: TxRecord) => {
    setSelectedTx(tx);
    detailSheetRef.current?.present();
  }, []);

  // Load the wallet address from secure storage on mount
  useEffect(() => {
    getWalletAddress().then(setWalletAddress).catch(() => setWalletAddress(null));
  }, []);

  // Initialise the activity feed (no-op when address is null — renders empty state)
  const { loading, error } = useInitActivityFeed(walletAddress, WRAITH_URL);

  return (
    <ScreenScaffold
      hideBack
      eyebrow="Veil Wallet"
      title="Dashboard"
      description="Your passkey-powered Stellar wallet."
    >
      <View style={styles.balanceHero}>
        <Text style={styles.balanceLabel}>Available balance</Text>
        <Text style={styles.balanceValue}>— XLM</Text>
        <Text style={styles.balanceHint}>
          Balance will load once the wallet screen is implemented.
        </Text>
      </View>

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Quick actions</Text>
        <Text style={styles.sectionHint}>Send · Receive · Swap · Buy</Text>
      </View>

      <QuickActions />

      <View style={styles.grid}>
        <NavRow href="/settings" label="Settings" hint="Wallet & app prefs" />
      </View>

      {/* Activity feed */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Activity</Text>
        <Text style={styles.sectionHint}>Recent transfers</Text>
      </View>
      <ActivityFeed filter="all" loading={loading} error={error} onSelectTx={handleSelectTx} />

      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Stack routes</Text>
        <Text style={styles.sectionHint}>Available screens</Text>
      </View>

      <View style={styles.grid}>
        <NavRow href="/swap" label="Swap" hint="DEX + Soroswap" />
        <NavRow href="/agent" label="Agent" hint="Activity feed" />
        <NavRow href="/vault" label="Vault" hint="Time-locked balance" />
        <NavRow href="/multisig" label="Multisig" hint="M-of-N wallets" />
        <NavRow href="/earn" label="Earn" hint="Blend yield" />
        <NavRow href="/pools" label="Pools" hint="Liquidity pools" />
        <NavRow href="/buy" label="Buy" hint="Transak / SEP-24" />
        <NavRow href="/withdraw" label="Withdraw" hint="Fiat off-ramp" />
        <NavRow href="/token/XLM" label="Token · XLM" hint="Dynamic route demo" />
      </View>

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Connected dApps</Text>
        <ThemeToggle />
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={() => setIsConnectOpen(true)}
        style={({ pressed }) => [themedStyles.connectButton, pressed && themedStyles.pressed]}
      >
        <Text style={themedStyles.connectLabel}>Connect dApp</Text>
      </Pressable>

      {sessions.length > 0 && (
        <View style={themedStyles.sessions}>
          {sessions.map((session) => (
            <View key={session.topic} style={themedStyles.sessionRow}>
              <Text style={themedStyles.sessionName} numberOfLines={1}>
                {session.peer?.name || 'Unknown dApp'}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  disconnectSession(session.topic).catch(() => {});
                }}
              >
                <Text style={themedStyles.disconnect}>Disconnect</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}

      <ConnectDAppModal isOpen={isConnectOpen} onClose={() => setIsConnectOpen(false)} />

      {/* Shows once per install; self-gates on the persisted flag. */}
      <FirstRunTutorial />

      {/* Opened by tapping a row in the activity feed. */}
      <TxDetailSheet ref={detailSheetRef} tx={selectedTx} />
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  balanceHero: {
    marginTop: 8,
    padding: 20,
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  balanceLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  balanceValue: {
    color: colors.offWhite,
    fontSize: 40,
    fontWeight: '700',
    letterSpacing: -1,
  },
  balanceHint: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 4,
  },
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