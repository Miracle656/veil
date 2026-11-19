import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FlowHeader } from '../components/FlowHeader';
import { SuccessAnimation } from '../components/SuccessAnimation';
import { TokenIcon } from '../components/TokenIcon';
import { useWallet } from '../components/WalletProvider';
import { useTheme } from '../hooks/useTheme';
import {
  CLAIM_STILL_WAITING_MESSAGE,
  MAX_SPONSORED_CLAIM_XLM_PER_WALLET,
  executeOneTapClaim,
  inspectClaimBeforePrompt,
  type ClaimPreviewState,
  type ExecuteClaimResult,
} from '../lib/claimFlow';
import { errorMessage } from '../lib/errorMessage';
import { WALLET_CREATION_LIMITATION_MESSAGE } from '../lib/platformLimitation';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';

function firstParam(val: string | string[] | undefined): string {
  if (Array.isArray(val)) return val[0] ?? '';
  return val ?? '';
}

function readWebHashSecret(): string | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const hash = window.location?.hash?.replace(/^#/, '') ?? '';
  if (!hash) return null;
  for (const part of hash.split('&')) {
    const eq = part.indexOf('=');
    const key = eq === -1 ? part : part.slice(0, eq);
    const val = eq === -1 ? '' : decodeURIComponent(part.slice(eq + 1));
    if ((key === 's' || key === 'secret') && /^S[A-Z2-7]{55}$/.test(val.trim())) {
      return val.trim();
    }
  }
  return null;
}

export default function ClaimScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { wallet } = useWallet();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const params = useLocalSearchParams<{
    id?: string;
    amount?: string;
    asset?: string;
    issuer?: string;
    sender?: string;
    note?: string;
    expires?: string;
    s?: string;
  }>();

  const balanceId = firstParam(params.id);
  const paramAmount = firstParam(params.amount) || undefined;
  const paramAsset = firstParam(params.asset) || undefined;
  const paramIssuer = firstParam(params.issuer) || null;
  const paramSender = firstParam(params.sender) || null;
  const paramNote = firstParam(params.note) || null;
  const paramExpiresRaw = firstParam(params.expires);
  const paramExpires = paramExpiresRaw ? Number(paramExpiresRaw) : null;
  const paramSecret = firstParam(params.s) || readWebHashSecret();

  const [loadingPreview, setLoadingPreview] = useState(true);
  const [preview, setPreview] = useState<ClaimPreviewState | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [settled, setSettled] = useState<Extract<ExecuteClaimResult, { status: 'claimed' }> | null>(
    null,
  );
  const [prfRefusal, setPrfRefusal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const loadPreview = useCallback(async () => {
    setLoadingPreview(true);
    setError(null);
    try {
      const state = await inspectClaimBeforePrompt({
        balanceId,
        amount: paramAmount,
        assetCode: paramAsset,
        assetIssuer: paramIssuer,
        sender: paramSender,
        note: paramNote,
        expiresAt: Number.isFinite(paramExpires) ? paramExpires : null,
        ephemeralSecret: paramSecret,
      });
      setPreview(state);
    } catch (err) {
      setError(`${errorMessage(err)} ${CLAIM_STILL_WAITING_MESSAGE}`);
    } finally {
      setLoadingPreview(false);
    }
  }, [
    balanceId,
    paramAmount,
    paramAsset,
    paramExpires,
    paramIssuer,
    paramNote,
    paramSecret,
    paramSender,
  ]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const handleOneTapClaim = async () => {
    if (!preview || preview.status !== 'ready' || inFlightRef.current) return;
    inFlightRef.current = true;
    setClaiming(true);
    setError(null);
    setPrfRefusal(null);

    try {
      const outcome = await executeOneTapClaim(wallet, {
        balanceId: preview.balanceId,
        amount: preview.amount,
        assetCode: preview.assetCode,
        assetIssuer: preview.assetIssuer,
        sender: preview.senderLabel,
        note: preview.note,
        expiresAt: preview.expiresAt,
        ephemeralSecret: paramSecret,
      });

      if (outcome.status === 'claimed') {
        setSettled(outcome);
        return;
      }
      if (outcome.status === 'already_claimed') {
        setPreview({
          status: 'already_claimed',
          balanceId: preview.balanceId,
          message: outcome.message,
        });
        return;
      }
      if (outcome.status === 'prf_unsupported') {
        setPrfRefusal(outcome.message);
        return;
      }
      // Cancelled biometric prompt: keep preview open with no error banner.
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setClaiming(false);
      inFlightRef.current = false;
    }
  };

  if (settled) {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="claim-success-screen">
        <View style={styles.body}>
          <FlowHeader title="Money claimed" />
          <View style={styles.centerWrap}>
            <SuccessAnimation
              title={`${settled.amount} ${settled.assetCode} claimed`}
              subtitle={
                settled.createdNewWallet
                  ? 'Your passkey wallet is set up and funded.'
                  : 'Added to your wallet.'
              }
            />
            <Text style={styles.metaLine} testID="claim-success-amount">
              {settled.amount} {settled.assetCode} is now in your wallet
            </Text>
            <Pressable
              testID="claim-open-wallet-button"
              accessibilityRole="button"
              onPress={() => router.replace('/dashboard')}
              style={({ pressed }) => [styles.cta, styles.fullWidth, pressed && styles.pressed]}
            >
              <Text style={styles.ctaText}>Open wallet</Text>
            </Pressable>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="claim-screen">
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <FlowHeader title="Claim" />

        {loadingPreview ? (
          <View style={styles.card} testID="claim-loading">
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.supporting}>Checking your claim link…</Text>
          </View>
        ) : preview?.status === 'already_claimed' ? (
          <View style={styles.card} testID="claim-already-claimed">
            <Text style={styles.terminalTitle}>Already claimed</Text>
            <Text style={styles.supporting}>{preview.message}</Text>
          </View>
        ) : preview?.status === 'already_in_wallet' ? (
          <View style={styles.card} testID="claim-already-in-wallet">
            <Text style={styles.terminalTitle}>Already in your wallet</Text>
            <Text style={styles.supporting}>{preview.message}</Text>
            <Pressable
              testID="claim-open-wallet-button"
              accessibilityRole="button"
              onPress={() => router.replace('/dashboard')}
              style={({ pressed }) => [styles.cta, pressed && styles.pressed]}
            >
              <Text style={styles.ctaText}>Open wallet</Text>
            </Pressable>
          </View>
        ) : preview?.status === 'invalid_link' ? (
          <View style={styles.card} testID="claim-invalid-link">
            <Text style={styles.terminalTitle}>Invalid link</Text>
            <Text style={styles.supporting}>{preview.message}</Text>
          </View>
        ) : preview?.status === 'ready' ? (
          <>
            <View style={[styles.card, styles.previewCard]} testID="claim-preview-card">
              <TokenIcon code={preview.assetCode} size={44} />
              <Text style={styles.amountHero} testID="claim-preview-amount">
                {preview.amount} {preview.assetCode}
              </Text>
              {preview.senderLabel ? (
                <Text style={styles.senderLine} testID="claim-preview-sender">
                  From {preview.senderLabel}
                </Text>
              ) : null}
              {preview.note ? (
                <Text style={styles.noteLine} testID="claim-preview-note">
                  {preview.note}
                </Text>
              ) : null}
            </View>

            {preview.resumeNotice ? (
              <Text style={styles.resumeBanner} testID="claim-resume-notice">
                {preview.resumeNotice}
              </Text>
            ) : null}

            {!preview.hasExistingWallet && (
              <View style={styles.noticeCard} testID="claim-onboarding-notice">
                <Text style={styles.noticeText}>
                  One tap creates a passkey wallet secured by your Face ID or fingerprint and claims
                  this payment. Veil covers setup fees (up to {MAX_SPONSORED_CLAIM_XLM_PER_WALLET}{' '}
                  XLM).
                </Text>
                <Text style={styles.originText} testID="claim-origin-binding-notice">
                  {WALLET_CREATION_LIMITATION_MESSAGE}
                </Text>
              </View>
            )}

            {prfRefusal ? (
              <View style={styles.errorCard} testID="claim-prf-refused">
                <Text style={styles.errorTitle}>Passkey recovery required</Text>
                <Text style={styles.errorBody}>{prfRefusal}</Text>
              </View>
            ) : null}

            {error ? (
              <View style={styles.errorCard} testID="claim-error">
                <Text style={styles.errorBody}>{error}</Text>
              </View>
            ) : null}

            <Pressable
              testID="claim-one-tap-button"
              accessibilityRole="button"
              disabled={claiming}
              onPress={() => void handleOneTapClaim()}
              style={({ pressed }) => [
                styles.cta,
                claiming && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              {claiming ? (
                <>
                  <ActivityIndicator color={colors.onAccent} />
                  <Text style={styles.ctaText}>Setting up wallet and claiming…</Text>
                </>
              ) : (
                <Text style={styles.ctaText}>
                  {prfRefusal
                    ? 'Try a different passkey'
                    : preview.resumingStage
                      ? `Resume claiming ${preview.amount} ${preview.assetCode}`
                      : `Claim ${preview.amount} ${preview.assetCode}`}
                </Text>
              )}
            </Pressable>
          </>
        ) : error ? (
          <View style={styles.errorCard} testID="claim-error">
            <Text style={styles.errorBody}>{error}</Text>
            <Pressable
              testID="claim-retry-preview"
              accessibilityRole="button"
              onPress={() => void loadPreview()}
              style={({ pressed }) => [styles.cta, pressed && styles.pressed]}
            >
              <Text style={styles.ctaText}>Try again</Text>
            </Pressable>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    body: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 40, gap: 14 },
    centerWrap: { alignItems: 'center', marginTop: 44, gap: 18 },
    fullWidth: { alignSelf: 'stretch' },
    card: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 20,
      padding: 22,
      gap: 10,
    },
    previewCard: {
      alignItems: 'center',
      paddingVertical: 28,
      marginTop: 8,
    },
    amountHero: {
      color: colors.textStrong,
      fontFamily: fontFamily.heading,
      fontSize: 40,
      lineHeight: 46,
      marginTop: 6,
    },
    senderLine: {
      color: colors.textSecondary,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
    },
    noteLine: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 14,
      textAlign: 'center',
      lineHeight: 20,
    },
    terminalTitle: {
      color: colors.textStrong,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 18,
    },
    supporting: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 14,
      lineHeight: 20,
    },
    metaLine: {
      color: colors.textSecondary,
      fontFamily: fontFamily.bodyMedium,
      fontSize: 14,
    },
    resumeBanner: {
      color: colors.accentText,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.accent,
      borderRadius: 14,
      padding: 12,
      fontFamily: fontFamily.bodyMedium,
      fontSize: 13,
      lineHeight: 19,
    },
    noticeCard: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      borderRadius: 16,
      padding: 16,
      gap: 8,
    },
    noticeText: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
    },
    originText: {
      color: colors.accentText,
      fontFamily: fontFamily.body,
      fontSize: 12,
      lineHeight: 18,
    },
    errorCard: {
      backgroundColor: colors.dangerSurface,
      borderRadius: 14,
      padding: 14,
      gap: 6,
    },
    errorTitle: {
      color: colors.danger,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 14,
    },
    errorBody: {
      color: colors.danger,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
    },
    cta: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: colors.accent,
      borderRadius: 100,
      paddingVertical: 17,
      marginTop: 8,
    },
    ctaText: {
      color: colors.onAccent,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
    },
    disabled: { opacity: 0.45 },
    pressed: { opacity: 0.7 },
  });
