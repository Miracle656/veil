import { Keypair } from '@stellar/stellar-sdk';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FlowHeader } from '../components/FlowHeader';
import { useTheme } from '../hooks/useTheme';
import { getFeePayerAddress } from '../lib/activity';
import { errorMessage } from '../lib/errorMessage';
import {
  CLAIM_LINK_EXPIRY_PRESETS,
  DEFAULT_CLAIM_LINK_EXPIRY_ID,
  fetchWalletTiedUpSummary,
  reclaimEscrowSafely,
  type KnownSenderClaimLink,
  type SenderClaimLinkItem,
  type TiedUpLinksSummary,
} from '../lib/escrow';
import { getNetwork } from '../lib/network';
import { requirePasskey } from '../lib/passkey';
import { isPasskeyCancellation } from '../lib/passkeyOutcome';
import type { ThemeColors } from '../lib/theme';
import { getSignerSecret, getWalletAddress } from '../lib/walletStore';
import { fontFamily } from '../theme/typography';

const CREATED_CLAIM_LINKS_STORAGE_PREFIX = 'veil_created_claim_links_v1:';
const LEGACY_CLAIM_LINKS_STORAGE_PREFIX = 'veil_sender_claim_links_v1:';

async function readKnownLinks(walletAddress: string): Promise<KnownSenderClaimLink[]> {
  try {
    const [primaryRaw, legacyRaw] = await Promise.all([
      AsyncStorage.getItem(`${CREATED_CLAIM_LINKS_STORAGE_PREFIX}${walletAddress}`).catch(() => null),
      AsyncStorage.getItem(`${LEGACY_CLAIM_LINKS_STORAGE_PREFIX}${walletAddress}`).catch(() => null),
    ]);
    const combined: KnownSenderClaimLink[] = [];
    const seen = new Set<string>();
    for (const raw of [primaryRaw, legacyRaw]) {
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) continue;
        for (const item of parsed as KnownSenderClaimLink[]) {
          if (item && typeof item.balanceId === 'string' && item.balanceId && !seen.has(item.balanceId)) {
            seen.add(item.balanceId);
            combined.push(item);
          }
        }
      } catch {
        // Ignore malformed local metadata entry.
      }
    }
    return combined;
  } catch {
    return [];
  }
}

async function markKnownLinkReclaimedBySender(
  walletAddress: string,
  balanceId: string,
): Promise<void> {
  for (const prefix of [CREATED_CLAIM_LINKS_STORAGE_PREFIX, LEGACY_CLAIM_LINKS_STORAGE_PREFIX]) {
    try {
      const key = `${prefix}${walletAddress}`;
      const raw = await AsyncStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) continue;
      const updated = (parsed as Record<string, unknown>[]).map((entry) =>
        entry && entry.balanceId === balanceId ? { ...entry, reclaimedBySender: true } : entry,
      );
      await AsyncStorage.setItem(key, JSON.stringify(updated));
    } catch {
      // Non-fatal local hint update.
    }
  }
}

async function resolveClassicSponsorAddress(): Promise<string | null> {
  const feePayer = await getFeePayerAddress().catch(() => null);
  if (feePayer) return feePayer;
  const wallet = await getWalletAddress().catch(() => null);
  return wallet && wallet.startsWith('G') ? wallet : null;
}

export default function ClaimLinksScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<TiedUpLinksSummary | null>(null);
  const [reclaimingId, setReclaimingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadLinks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sponsor = await resolveClassicSponsorAddress();
      if (!sponsor) {
        setSummary(null);
        return;
      }
      const network = getNetwork();
      const knownLinks = await readKnownLinks(sponsor);
      const next = await fetchWalletTiedUpSummary(
        sponsor,
        {
          horizonUrl: network.horizonUrl,
          networkPassphrase: network.networkPassphrase,
        },
        { knownLinks },
      );
      setSummary(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLinks();
  }, [loadLinks]);

  const handleReclaim = useCallback(
    async (item: SenderClaimLinkItem) => {
      setError(null);
      setFeedback(null);
      if (!item.canReclaim) {
        setError(
          'This link has not expired yet. You can reclaim the funds once the expiry window ends.',
        );
        return;
      }

      setReclaimingId(item.balanceId);
      try {
        await requirePasskey();
        const secret = await getSignerSecret();
        if (!secret) {
          throw new Error('No signing key is available on this device to reclaim funds.');
        }
        const senderKeypair = Keypair.fromSecret(secret);
        const network = getNetwork();
        const outcome = await reclaimEscrowSafely({
          senderKeypair,
          balanceId: item.balanceId,
          expiresAt: item.expiresAt,
          assetCode: item.assetCode,
          assetIssuer: item.assetIssuer,
          config: {
            horizonUrl: network.horizonUrl,
            networkPassphrase: network.networkPassphrase,
          },
        });

        if (outcome.status === 'reclaimed') {
          await markKnownLinkReclaimedBySender(senderKeypair.publicKey(), item.balanceId);
          setFeedback(
            `Reclaimed ${item.amount} ${item.assetCode} and freed ${outcome.sweptReserveXlm} XLM of reserve.`,
          );
          await loadLinks();
          return;
        }
        setError(outcome.message);
        if (outcome.status === 'already_claimed' || outcome.status === 'already_reclaimed') {
          await loadLinks();
        }
      } catch (err) {
        if (isPasskeyCancellation(err)) {
          return;
        }
        setError(errorMessage(err));
      } finally {
        setReclaimingId(null);
      }
    },
    [loadLinks],
  );

  const defaultPreset = CLAIM_LINK_EXPIRY_PRESETS.find(
    (p) => p.id === DEFAULT_CLAIM_LINK_EXPIRY_ID,
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="claim-links-screen">
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <FlowHeader title="Claim links" />

        <View style={styles.summaryCard} testID="claim-links-tied-up-card">
          <Text style={styles.overline}>Tied up in unclaimed links</Text>
          {loading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.muted}>Checking on-chain claimable balances...</Text>
            </View>
          ) : !summary || summary.openLinkCount === 0 ? (
            <Text style={styles.emptySummary} testID="claim-links-tied-up-empty">
              Nothing is tied up in unclaimed links. Open links hold {defaultPreset?.label ?? '7 days'} by default and lock 1 XLM of refundable reserve until claimed or reclaimed.
            </Text>
          ) : (
            <>
              <Text style={styles.summaryPrimary} testID="claim-links-locked-reserve">
                {summary.lockedReserveXlm} XLM reserve locked across {summary.openLinkCount}{' '}
                {summary.openLinkCount === 1 ? 'open link' : 'open links'}
              </Text>
              {summary.assets.map((asset) => (
                <Text
                  key={asset.assetKey}
                  style={styles.summaryAsset}
                  testID={`claim-links-asset-${asset.assetCode}`}
                >
                  {asset.totalAmount} {asset.assetCode} unclaimed
                  {asset.reclaimableAmount !== '0'
                    ? ` · ${asset.reclaimableAmount} ${asset.assetCode} ready to reclaim`
                    : ''}
                </Text>
              ))}
              {summary.expiredUnreclaimedCount > 0 && (
                <Text style={styles.reclaimReadyHint} testID="claim-links-reclaimable-hint">
                  {summary.expiredUnreclaimedCount}{' '}
                  {summary.expiredUnreclaimedCount === 1 ? 'expired link can' : 'expired links can'}{' '}
                  be reclaimed now to recover {summary.reclaimableReserveXlm} XLM in reserve.
                </Text>
              )}
            </>
          )}
        </View>

        {feedback ? (
          <Text style={styles.feedbackBanner} testID="claim-links-feedback">
            {feedback}
          </Text>
        ) : null}

        {error ? (
          <Text style={styles.errorBanner} testID="claim-links-error">
            {error}
          </Text>
        ) : null}

        <Text style={styles.section}>Created links</Text>
        {!loading && (!summary || summary.links.length === 0) ? (
          <View style={styles.card}>
            <Text style={styles.muted} testID="claim-links-empty-list">
              Links you send appear here with their live on-chain state and expiry window.
            </Text>
          </View>
        ) : null}

        {summary?.links.map((item) => {
          const busy = reclaimingId === item.balanceId;
          return (
            <View
              key={item.balanceId}
              style={styles.card}
              testID={`claim-link-row-${item.balanceId}`}
            >
              <View style={styles.rowBetween}>
                <Text style={styles.amountText}>
                  {item.amount} {item.assetCode}
                </Text>
                <Text
                  style={[
                    styles.stateBadge,
                    item.state === 'expired_unreclaimed' && styles.stateExpired,
                    item.state === 'claimed_by_other' && styles.stateClaimed,
                  ]}
                  testID={`claim-link-state-${item.balanceId}`}
                >
                  {item.statusLabel}
                </Text>
              </View>
              <Text style={styles.expiryText} testID={`claim-link-expiry-${item.balanceId}`}>
                {item.senderExpiryLabel}
              </Text>
              {item.reserveLockedXlm !== '0' ? (
                <Text style={styles.reserveLine}>
                  Holds {item.reserveLockedXlm} XLM refundable reserve until resolved
                </Text>
              ) : null}

              {item.state === 'expired_unreclaimed' ? (
                <Pressable
                  testID={`claim-link-reclaim-${item.balanceId}`}
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void handleReclaim(item)}
                  style={({ pressed }) => [
                    styles.reclaimBtn,
                    busy && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  {busy ? (
                    <ActivityIndicator color={colors.onAccent} />
                  ) : (
                    <Text style={styles.reclaimBtnText}>Reclaim funds and reserve</Text>
                  )}
                </Pressable>
              ) : item.state === 'active' ? (
                <Pressable
                  testID={`claim-link-reclaim-${item.balanceId}`}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: true }}
                  onPress={() => void handleReclaim(item)}
                  style={[styles.reclaimBtnSecondary, styles.disabled]}
                >
                  <Text style={styles.reclaimSecondaryText}>Reclaim unlocks after expiry</Text>
                </Pressable>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    body: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 40, gap: 12 },
    overline: {
      color: colors.textFaint,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 11,
      letterSpacing: 1.3,
      textTransform: 'uppercase',
      marginBottom: 8,
    },
    section: {
      color: colors.textFaint,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 11,
      letterSpacing: 1.4,
      textTransform: 'uppercase',
      marginTop: 12,
      marginBottom: 4,
    },
    summaryCard: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      borderRadius: 18,
      padding: 18,
      gap: 6,
    },
    summaryPrimary: {
      color: colors.textStrong,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 16,
      lineHeight: 22,
    },
    summaryAsset: {
      color: colors.textSecondary,
      fontFamily: fontFamily.address,
      fontSize: 13,
      lineHeight: 19,
    },
    reclaimReadyHint: {
      color: colors.accentText,
      fontFamily: fontFamily.bodyMedium,
      fontSize: 13,
      marginTop: 4,
    },
    emptySummary: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 13.5,
      lineHeight: 20,
    },
    loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    card: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 16,
      padding: 16,
      gap: 6,
    },
    rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    amountText: {
      color: colors.textStrong,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 16,
    },
    stateBadge: {
      color: colors.textSecondary,
      fontFamily: fontFamily.bodyMedium,
      fontSize: 12,
    },
    stateExpired: { color: colors.accentText },
    stateClaimed: { color: colors.positive },
    expiryText: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 13,
    },
    reserveLine: {
      color: colors.textFaint,
      fontFamily: fontFamily.address,
      fontSize: 12,
    },
    muted: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
    },
    reclaimBtn: {
      marginTop: 8,
      backgroundColor: colors.accent,
      borderRadius: 100,
      paddingVertical: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    reclaimBtnText: {
      color: colors.onAccent,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 14,
    },
    reclaimBtnSecondary: {
      marginTop: 8,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 100,
      paddingVertical: 11,
      alignItems: 'center',
      justifyContent: 'center',
    },
    reclaimSecondaryText: {
      color: colors.textMuted,
      fontFamily: fontFamily.bodyMedium,
      fontSize: 13,
    },
    feedbackBanner: {
      color: colors.positive,
      backgroundColor: colors.positiveSurface,
      fontFamily: fontFamily.bodyMedium,
      fontSize: 13,
      borderRadius: 12,
      padding: 12,
    },
    errorBanner: {
      color: colors.danger,
      backgroundColor: colors.dangerSurface,
      fontFamily: fontFamily.body,
      fontSize: 13,
      borderRadius: 12,
      padding: 12,
    },
    disabled: { opacity: 0.45 },
    pressed: { opacity: 0.7 },
  });
