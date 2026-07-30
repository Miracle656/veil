import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ScreenScaffold, ComingSoonBadge, NavRow, colors } from '@/components/ScreenScaffold';
import { ConnectDAppModal } from '../../components/ConnectDAppModal';
import { ThemeToggle } from '../../components/ThemeToggle';
import { useWalletConnect } from '../../hooks/useWalletConnect';
import { useTheme } from '../../hooks/useTheme';
import type { ThemeColors } from '../../lib/theme';

/**
 * Dashboard tab — primary destination after unlock.
 *
 * In the navigation shell this view hosts the link grid that proves every
 * non-tab route is reachable from the tab bar. As screens are built out,
 * individual NavRow entries will be replaced by their real counterparts.
 *
 * The dApp connection controls previously lived on the landing route; that
 * route now redirects into this tab group, so they were moved here to stay
 * reachable.
 */
export default function DashboardTab() {
  const { colors: themeColors } = useTheme();
  const themedStyles = useMemo(() => createThemedStyles(themeColors), [themeColors]);
  const { sessions, disconnectSession } = useWalletConnect();
  const [isConnectOpen, setIsConnectOpen] = useState(false);

  return (
    <ScreenScaffold
      hideBack
      eyebrow="Veil Wallet"
      title="Dashboard"
      description="Your passkey-powered Stellar wallet. Pick a destination to navigate to."
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
        <Text style={styles.sectionHint}>Tab destinations</Text>
      </View>

      <View style={styles.grid}>
        <NavRow href="/send" label="Send" hint="Move XLM or assets" />
        <NavRow href="/receive" label="Receive" hint="Share your address" />
        <NavRow href="/settings" label="Settings" hint="Wallet & app prefs" />
      </View>

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

      <ComingSoonBadge note="Dashboard screen — UI lands in a follow-up issue" />
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
