/**
 * PrivateBalanceCard — the dashboard card for the user's shielded XLM balance.
 *
 * Design intent
 * ─────────────
 * Sits directly below the SilverBalanceCard on the dashboard.  Where the
 * silver card represents the public "visible" balance, this card is dark and
 * minimal — near-black background, gold accents, a subtle shield glyph — to
 * signal that funds here are private.  The balance is masked by the
 * hide-amounts toggle exactly like the public card.
 *
 * Action buttons
 * ──────────────
 * Three pill buttons on the bottom row: Shield (public → private), Send
 * (private send), Unshield (private → public).  All three push into the
 * /privacy/* sub-navigator.
 *
 * Refresh behaviour
 * ─────────────────
 * The card reads from the privacy external store (instant, cached) and calls
 * `refreshPrivateBalance()` on mount so the figure stays current after
 * transactions.  It does NOT poll — the dashboard already has a 15 s poller
 * that can call the refresh helper in a future iteration.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useTheme } from '../hooks/useTheme';
import { useHiddenAmounts } from '../hooks/useHiddenAmounts';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import {
  getPrivateBalance,
  isPrivateBalanceHydrated,
  refreshPrivateBalance,
  subscribeToPrivacy,
} from '../lib/privacy';
import { ShieldIcon, PaperPlaneIcon, UnshieldIcon } from './icons';

// Gold tints used throughout this card.
const GOLD = '#FDDA24';
const GOLD_08 = 'rgba(253,218,36,0.08)';
const GOLD_15 = 'rgba(253,218,36,0.15)';
const GOLD_25 = 'rgba(253,218,36,0.25)';
const NEAR_BLACK = '#0F0F0F';

function trimAmt(raw: string): string {
  const n = Number(raw);
  if (!isFinite(n)) return raw;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

export function PrivateBalanceCard() {
  const router = useRouter();
  const { colors } = useTheme();
  const { mask, hidden } = useHiddenAmounts();
  const styles = useMemo(() => createStyles(colors), [colors]);

  // Subscribe to the privacy external store so the card re-renders whenever
  // the balance changes (e.g. right after a shield/unshield completes).
  const balance = useSyncExternalStore(
    subscribeToPrivacy,
    getPrivateBalance,
    getPrivateBalance,
  );
  const hydrated = useSyncExternalStore(
    subscribeToPrivacy,
    isPrivateBalanceHydrated,
    isPrivateBalanceHydrated,
  );

  // Refresh on mount — picks up any changes from the last session.
  useEffect(() => {
    void refreshPrivateBalance();
  }, []);

  const displayBalance =
    !hydrated
      ? '—'
      : mask(`${trimAmt(balance ?? '0')} XLM`);

  const handleShield = useCallback(() => router.push('/privacy/shield'), [router]);
  const handleSend   = useCallback(() => router.push('/privacy/send'),   [router]);
  const handleUnshield = useCallback(() => router.push('/privacy/unshield'), [router]);

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
          <Text style={styles.privacyBadgeText}>ZK-shielded</Text>
        </View>
      </View>

      {/* Balance */}
      <Text
        style={styles.amount}
        numberOfLines={1}
        adjustsFontSizeToFit
        accessibilityLabel={hidden ? 'Balance hidden' : `Private balance: ${balance ?? '0'} XLM`}
      >
        {displayBalance}
      </Text>

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

    // Balance
    amount: {
      fontFamily: fontFamily.heading,
      fontSize: 38,
      lineHeight: 44,
      color: GOLD,
      marginBottom: 18,
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
