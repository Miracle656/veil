/**
 * PrivateBalanceCard — dashboard preview of the shielded (private) balance.
 *
 * Mirrors the web wallet's card (#751): it renders NOTHING unless the privacy
 * feature is enabled — `isPrivacyEnabled()` from lib/privacy/config, which is a
 * build-time flag and unconditionally off on mainnet — and it never paints an
 * amount until a pool scan reports `up-to-date`.
 *
 * There is no scanner yet (see lib/privacy.ts), so in practice the card sits in
 * its honest "not available yet" state rather than showing a confident 0.00 XLM,
 * which would read as "you have no private funds" when it means "we haven't
 * looked". The shield / send / unshield buttons route into the preview screens.
 */

import { useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useTheme } from '../hooks/useTheme';
import { useHiddenAmounts } from '../hooks/useHiddenAmounts';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { isPrivacyEnabled } from '../lib/privacy/config';
import {
  getPrivateBalances,
  getPrivateSyncState,
  type PrivateBalance,
  type PrivateSyncState,
} from '../lib/privacy';
import { ShieldIcon, PaperPlaneIcon, UnshieldIcon } from './icons';

// Gold tints used throughout this card.
const GOLD = '#FDDA24';
const GOLD_08 = 'rgba(253,218,36,0.08)';
const GOLD_15 = 'rgba(253,218,36,0.15)';
const GOLD_25 = 'rgba(253,218,36,0.25)';
const NEAR_BLACK = '#0F0F0F';

const STATUS_COPY: Record<PrivateSyncState, string> = {
  syncing: 'Syncing',
  'up-to-date': 'Up to date',
  'needs-history': 'Needs history',
};

export function PrivateBalanceCard({
  balances = getPrivateBalances(),
  syncState = getPrivateSyncState(),
}: {
  balances?: PrivateBalance[];
  syncState?: PrivateSyncState;
} = {}) {
  const router = useRouter();
  const { colors } = useTheme();
  const { mask, hidden } = useHiddenAmounts();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const handleShield = useCallback(() => router.push('/privacy/shield'), [router]);
  const handleSend = useCallback(() => router.push('/privacy/send'), [router]);
  const handleUnshield = useCallback(() => router.push('/privacy/unshield'), [router]);

  // Single gate for the whole feature. Off by default and never on mainnet, so
  // nothing below can leak the private UI into a production/mainnet build.
  if (!isPrivacyEnabled()) return null;

  return (
    <View style={styles.card} accessibilityLabel="Private balance card">
      {/* Subtle corner shield watermark */}
      <View style={styles.watermark} pointerEvents="none">
        <ShieldIcon size={72} color={GOLD_08} />
      </View>

      {/* Header row */}
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <ShieldIcon size={14} color={GOLD} />
          <Text style={styles.headerLabel}>PRIVATE BALANCE</Text>
        </View>
        <View style={styles.privacyBadge}>
          <Text style={styles.privacyBadgeText}>{STATUS_COPY[syncState]}</Text>
        </View>
      </View>

      {/* Balance — never an amount until the scan is up to date. */}
      {syncState === 'up-to-date' ? (
        balances.length === 0 ? (
          <Text style={styles.pendingCopy}>No shielded balance yet.</Text>
        ) : (
          <View style={styles.balanceList}>
            {balances.map((b) => (
              <View key={b.code} style={styles.balanceRow}>
                <Text style={styles.balanceCode}>{b.code}</Text>
                <Text
                  style={styles.balanceAmount}
                  accessibilityLabel={
                    hidden ? 'Balance hidden' : `Private balance: ${b.amount} ${b.code}`
                  }
                >
                  {mask(`${parseFloat(b.amount).toFixed(4)} ${b.code}`)}
                </Text>
              </View>
            ))}
          </View>
        )
      ) : syncState === 'needs-history' ? (
        <Text style={styles.pendingCopy}>
          Pool history is older than the RPC window. Connect the bootnode to finish syncing.
        </Text>
      ) : (
        <Text style={styles.pendingCopy}>
          Private payments are not available in this build yet — balances appear once the pool
          scanner is integrated.
        </Text>
      )}

      {/* Divider */}
      <View style={styles.divider} />

      {/* Action buttons */}
      <View style={styles.actions}>
        <Pressable
          onPress={handleShield}
          accessibilityRole="button"
          accessibilityLabel="Shield — move XLM to private balance"
          style={({ pressed }) => [styles.actionBtn, pressed && styles.pressed]}
        >
          <ShieldIcon size={14} color={GOLD} />
          <Text style={styles.actionText}>Shield</Text>
        </Pressable>

        <View style={styles.separator} />

        <Pressable
          onPress={handleSend}
          accessibilityRole="button"
          accessibilityLabel="Send privately"
          style={({ pressed }) => [styles.actionBtn, pressed && styles.pressed]}
        >
          <PaperPlaneIcon size={14} color={GOLD} />
          <Text style={styles.actionText}>Send</Text>
        </Pressable>

        <View style={styles.separator} />

        <Pressable
          onPress={handleUnshield}
          accessibilityRole="button"
          accessibilityLabel="Unshield — return XLM to public balance"
          style={({ pressed }) => [styles.actionBtn, pressed && styles.pressed]}
        >
          <UnshieldIcon size={14} color={GOLD} />
          <Text style={styles.actionText}>Unshield</Text>
        </Pressable>
      </View>
    </View>
  );
}

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: NEAR_BLACK,
      borderRadius: 24,
      borderWidth: 1,
      borderColor: GOLD_15,
      padding: 24,
      overflow: 'hidden',
      // Elevated shadow so it reads as a distinct layer from the public card.
      shadowColor: GOLD,
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.08,
      shadowRadius: 20,
      elevation: 6,
      gap: 0,
    },
    watermark: {
      position: 'absolute',
      right: -10,
      bottom: -10,
      opacity: 0.6,
    },

    // Header
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 12,
    },
    headerLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    headerLabel: {
      fontFamily: fontFamily.accent,
      fontSize: 10,
      letterSpacing: 1.4,
      color: GOLD,
    },
    privacyBadge: {
      backgroundColor: GOLD_08,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: GOLD_15,
      paddingHorizontal: 10,
      paddingVertical: 3,
    },
    privacyBadgeText: {
      fontFamily: fontFamily.bodyMedium,
      fontSize: 10,
      color: GOLD,
      letterSpacing: 0.4,
    },

    // Balance / pending copy
    pendingCopy: {
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 20,
      color: 'rgba(246,247,248,0.5)',
      marginBottom: 18,
    },
    balanceList: {
      gap: 8,
      marginBottom: 18,
    },
    balanceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    balanceCode: {
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
      color: GOLD,
    },
    balanceAmount: {
      fontFamily: fontFamily.heading,
      fontSize: 20,
      color: GOLD,
    },

    // Divider
    divider: {
      height: 1,
      backgroundColor: GOLD_15,
      marginBottom: 16,
    },

    // Action buttons
    actions: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-around',
    },
    actionBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 9,
      borderRadius: 999,
      backgroundColor: GOLD_08,
      borderWidth: 1,
      borderColor: GOLD_25,
    },
    actionText: {
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 13,
      color: GOLD,
    },
    separator: {
      width: 8,
    },
    pressed: {
      opacity: 0.65,
    },
  });
