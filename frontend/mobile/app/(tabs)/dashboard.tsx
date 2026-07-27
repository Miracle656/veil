import { ScreenScaffold, ComingSoonBadge, NavRow, colors } from '@/components/ScreenScaffold';
import { View, Text, StyleSheet } from 'react-native';

/**
 * Dashboard tab — primary destination after unlock.
 *
 * In the navigation shell this view hosts the link grid that proves every
 * non-tab route is reachable from the tab bar. As screens are built out,
 * individual NavRow entries will be replaced by their real counterparts.
 */
export default function DashboardTab() {
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
        <Text style={styles.balanceHint}>Balance will load once the wallet screen is implemented.</Text>
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
