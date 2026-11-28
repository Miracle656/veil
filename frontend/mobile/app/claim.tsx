import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FlowHeader } from '../components/FlowHeader';
import { SuccessAnimation } from '../components/SuccessAnimation';
import { TokenIcon } from '../components/TokenIcon';
import { useWallet } from '../components/WalletProvider';
import { useTheme } from '../hooks/useTheme';
import { getAssetIssuer, verifiedAsset } from '../lib/assets';
import {
  CLAIM_MAINNET_SPONSOR_UNAVAILABLE_MESSAGE,
  claimWithExistingWallet,
  createWalletAndClaim,
  dismissPendingClaim,
  isClaimSponsorshipAvailable,
  loadPendingClaimCheckpoint,
  MAX_SPONSORED_CLAIM_XLM_PER_WALLET,
  resumeInterruptedClaimOnChain,
  retryPendingPrfAndClaim,
  signInAndClaim,
  type OneTapClaimResult,
  type PendingClaimCheckpoint,
  type PendingPrfWallet,
} from '../lib/claimFlow';
import {
  clearClaimLinkSecret,
  extractSecretFromUrlFragment,
  peekClaimLinkSecret,
} from '../lib/deepLinks';
import { errorMessage } from '../lib/errorMessage';
import {
  inspectClaimLinkForOpener,
  type OpenerLinkInspection,
} from '../lib/escrow';
import { getNetwork, setNetwork } from '../lib/network';
import { requirePasskey } from '../lib/passkey';
import { isPasskeyCancellation } from '../lib/passkeyOutcome';
// TODO(#1003): remove platform limitation warning when multi-origin contract ships
import { WALLET_CREATION_LIMITATION_MESSAGE } from '../lib/platformLimitation';
import {
  parseClaimLinkNetwork,
  retryReleaseClaimReserve,
  validateClaimLinkNote,
} from '../lib/sendClaimLink';
import { requireSigner } from '../lib/signer';
import type { ThemeColors } from '../lib/theme';
import { hasUsableWallet } from '../lib/walletStore';
import { fontFamily } from '../theme/typography';

function firstParam(val: string | string[] | undefined): string {
  if (Array.isArray(val)) return val[0] ?? '';
  return val ?? '';
}

export default function ClaimScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { wallet } = useWallet();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const params = useLocalSearchParams<{ id?: string; network?: string; note?: string }>();
  const balanceId = firstParam(params.id).trim();
  const linkNetwork = useMemo(
    () => parseClaimLinkNetwork(firstParam(params.network)),
    [params.network],
  );
  const rawNote = firstParam(params.note);
  const safeNote = useMemo(
    () => (rawNote && validateClaimLinkNote(rawNote) === null ? rawNote.trim() : null),
    [rawNote],
  );

  const inboundUrl = Linking.useURL();

  const [loading, setLoading] = useState(true);
  const [inspection, setInspection] = useState<OpenerLinkInspection | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [walletReady, setWalletReady] = useState(false);
  const [ephemeralSecret, setEphemeralSecret] = useState<string | null>(null);
  const [pendingCheckpoint, setPendingCheckpoint] = useState<PendingClaimCheckpoint | null>(null);
  const [activeNetName, setActiveNetName] = useState<'testnet' | 'mainnet'>(() => getNetwork().name);

  const [claiming, setClaiming] = useState(false);
  const [onboardingAction, setOnboardingAction] = useState<'create' | 'signin' | 'retry-prf' | null>(
    null,
  );
  const [claimError, setClaimError] = useState<string | null>(null);
  const [prfRefused, setPrfRefused] = useState<{
    issue: PendingPrfWallet['issue'];
    reason: string;
    pendingWallet: PendingPrfWallet;
  } | null>(null);
  const [fundingRequired, setFundingRequired] = useState<{
    reason: string;
    requiredXlm: string;
    availableXlm: string;
    feePayerAddress: string | null;
  } | null>(null);
  const [claimedResult, setClaimedResult] = useState<{
    txHash: string;
    amount: string;
    assetCode: string;
    reserveReleased: boolean;
    reserveReleaseTxHash?: string;
    reserveReleaseError?: string;
    createdNewWallet?: boolean;
    resumed?: boolean;
  } | null>(null);
  const [retryingReserve, setRetryingReserve] = useState(false);
  const [copiedHash, setCopiedHash] = useState(false);

  const resolveSecret = useCallback(async (): Promise<string | null> => {
    if (balanceId) {
      const stashed = peekClaimLinkSecret(balanceId);
      if (stashed) return stashed;
    }
    const fromHook = extractSecretFromUrlFragment(inboundUrl);
    if (fromHook) return fromHook;
    const initial = await Linking.getInitialURL().catch(() => null);
    const fromInitial = extractSecretFromUrlFragment(initial);
    if (fromInitial) return fromInitial;
    const checkpoint = await loadPendingClaimCheckpoint().catch(() => null);
    if (checkpoint && checkpoint.balanceId === balanceId && checkpoint.ephemeralSecret) {
      return checkpoint.ephemeralSecret;
    }
    return null;
  }, [balanceId, inboundUrl]);

  const loadOnChainState = useCallback(async () => {
    if (!balanceId) {
      setLoading(false);
      setInspection(null);
      setLoadError('This claim link is incomplete — no claimable balance ID was found.');
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const net = getNetwork();
      setActiveNetName(net.name);
      const [inspected, usable, secret, checkpoint] = await Promise.all([
        inspectClaimLinkForOpener(
          balanceId,
          {
            horizonUrl: net.horizonUrl,
            networkPassphrase: net.networkPassphrase,
          },
          {
            linkNetwork,
            activeNetwork: net.name,
          },
        ),
        hasUsableWallet().catch(() => false),
        resolveSecret(),
        loadPendingClaimCheckpoint().catch(() => null),
      ]);
      const matchingCheckpoint = checkpoint?.balanceId === balanceId ? checkpoint : null;
      const effectiveSecret = secret ?? matchingCheckpoint?.ephemeralSecret ?? null;
      setPendingCheckpoint(matchingCheckpoint);
      setWalletReady(usable);
      setEphemeralSecret(effectiveSecret);

      // If an interrupted submission already landed Tx 1 for this wallet, resolve
      // its real 64-character Horizon transaction hash and finish Tx 2 reserve release.
      if (
        usable &&
        matchingCheckpoint?.stage === 'during_claim' &&
        inspected.state === 'claimed_by_other' &&
        effectiveSecret
      ) {
        const resumed = await resumeInterruptedClaimOnChain({
          balanceId,
          ephemeralSecret: effectiveSecret,
          checkpoint: matchingCheckpoint,
        }).catch(() => null);
        if (resumed && resumed.status === 'claimed') {
          if (resumed.reserveReleased) {
            clearClaimLinkSecret(balanceId);
            setEphemeralSecret(null);
            setPendingCheckpoint(null);
          }
          setInspection(inspected);
          setClaimedResult({
            txHash: resumed.txHash,
            amount: resumed.amount,
            assetCode: resumed.assetCode,
            reserveReleased: resumed.reserveReleased,
            reserveReleaseTxHash: resumed.reserveReleaseTxHash,
            reserveReleaseError: resumed.reserveReleaseError,
            createdNewWallet: resumed.createdNewWallet,
            resumed: true,
          });
          return;
        }
      }

      setInspection(inspected);
    } catch (err) {
      setInspection(null);
      setLoadError(
        `Could not read this claim link from the Stellar network (${errorMessage(err)}). Check your connection and try again.`,
      );
    } finally {
      setLoading(false);
    }
  }, [balanceId, linkNetwork, resolveSecret]);

  useEffect(() => {
    void loadOnChainState();
  }, [loadOnChainState]);

  const handleDismiss = useCallback(() => {
    void dismissPendingClaim(balanceId || undefined);
    setPendingCheckpoint(null);
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace((walletReady ? '/dashboard' : '/welcome') as never);
    }
  }, [balanceId, router, walletReady]);

  const handleSwitchNetwork = useCallback(async () => {
    if (!linkNetwork) return;
    await setNetwork(linkNetwork);
    await loadOnChainState();
  }, [linkNetwork, loadOnChainState]);

  const applyClaimOutcome = useCallback(
    async (res: OneTapClaimResult, secret: string) => {
      if (res.status === 'already_claimed') {
        clearClaimLinkSecret(balanceId);
        setEphemeralSecret(null);
        setPendingCheckpoint(null);
        await loadOnChainState();
        return;
      }
      if (res.status === 'prf_refused') {
        setPrfRefused({
          issue: res.issue,
          reason: res.reason,
          pendingWallet: res.pendingWallet,
        });
        return;
      }
      if (res.status === 'funding_required') {
        setFundingRequired({
          reason: res.reason,
          requiredXlm: res.requiredXlm,
          availableXlm: res.availableXlm,
          feePayerAddress: res.feePayerAddress,
        });
        const usable = await hasUsableWallet().catch(() => false);
        setWalletReady(usable);
        return;
      }
      if (res.reserveReleased) {
        clearClaimLinkSecret(balanceId);
        setEphemeralSecret(null);
        setPendingCheckpoint(null);
      } else {
        // Keep the link secret in memory so the user can retry Tx 2 and
        // release the 1 XLM sponsored base reserve without reopening the link.
        setEphemeralSecret(secret);
      }
      setWalletReady(true);
      setPrfRefused(null);
      setFundingRequired(null);
      setClaimedResult({
        txHash: res.txHash,
        amount: res.amount,
        assetCode: res.assetCode,
        reserveReleased: res.reserveReleased,
        reserveReleaseTxHash: res.reserveReleaseTxHash,
        reserveReleaseError: res.reserveReleaseError,
        createdNewWallet: res.createdNewWallet,
        resumed: res.resumed,
      });
    },
    [balanceId, loadOnChainState],
  );

  const handleClaim = useCallback(async () => {
    if (!balanceId || claiming) return;
    setClaimError(null);
    setFundingRequired(null);
    const secret = ephemeralSecret ?? (await resolveSecret());
    if (!secret) {
      setClaimError(
        'This claim link is missing its bearer secret (#s=…). Open the full link shared by the sender.',
      );
      return;
    }

    setClaiming(true);
    try {
      await requirePasskey();
      const res = await claimWithExistingWallet({
        balanceId,
        ephemeralSecret: secret,
        linkNetwork,
        note: safeNote,
        inspection,
      });
      await applyClaimOutcome(res, secret);
    } catch (err) {
      if (isPasskeyCancellation(err)) return;
      setClaimError(errorMessage(err));
    } finally {
      setClaiming(false);
    }
  }, [
    applyClaimOutcome,
    balanceId,
    claiming,
    ephemeralSecret,
    inspection,
    linkNetwork,
    resolveSecret,
    safeNote,
  ]);

  const handleCreateAndClaim = useCallback(async () => {
    if (!balanceId || claiming) return;
    setClaimError(null);
    setPrfRefused(null);
    setFundingRequired(null);
    const secret = ephemeralSecret ?? (await resolveSecret());
    if (!secret) {
      setClaimError(
        'This claim link is missing its bearer secret (#s=…). Open the full link shared by the sender.',
      );
      return;
    }

    setClaiming(true);
    setOnboardingAction('create');
    try {
      const res = await createWalletAndClaim({
        wallet,
        balanceId,
        ephemeralSecret: secret,
        linkNetwork,
        note: safeNote,
        inspection,
      });
      await applyClaimOutcome(res, secret);
    } catch (err) {
      if (isPasskeyCancellation(err)) return;
      setClaimError(errorMessage(err));
    } finally {
      setClaiming(false);
      setOnboardingAction(null);
    }
  }, [
    applyClaimOutcome,
    balanceId,
    claiming,
    ephemeralSecret,
    inspection,
    linkNetwork,
    resolveSecret,
    safeNote,
    wallet,
  ]);

  const handleRetryPrf = useCallback(async () => {
    if (!balanceId || claiming || !prfRefused) return;
    setClaimError(null);
    const secret = ephemeralSecret ?? (await resolveSecret());
    if (!secret) {
      setClaimError(
        'This claim link is missing its bearer secret (#s=…). Open the full link shared by the sender.',
      );
      return;
    }

    setClaiming(true);
    setOnboardingAction('retry-prf');
    try {
      const res = await retryPendingPrfAndClaim({
        pendingWallet: prfRefused.pendingWallet,
        balanceId,
        ephemeralSecret: secret,
        linkNetwork,
        note: safeNote,
        inspection,
      });
      await applyClaimOutcome(res, secret);
    } catch (err) {
      if (isPasskeyCancellation(err)) return;
      setClaimError(errorMessage(err));
    } finally {
      setClaiming(false);
      setOnboardingAction(null);
    }
  }, [
    applyClaimOutcome,
    balanceId,
    claiming,
    ephemeralSecret,
    inspection,
    linkNetwork,
    prfRefused,
    resolveSecret,
    safeNote,
  ]);

  const handleSignInAndClaim = useCallback(async () => {
    if (!balanceId || claiming) return;
    setClaimError(null);
    setPrfRefused(null);
    setFundingRequired(null);
    const secret = ephemeralSecret ?? (await resolveSecret());
    if (!secret) {
      setClaimError(
        'This claim link is missing its bearer secret (#s=…). Open the full link shared by the sender.',
      );
      return;
    }

    setClaiming(true);
    setOnboardingAction('signin');
    try {
      const res = await signInAndClaim({
        balanceId,
        ephemeralSecret: secret,
        linkNetwork,
        note: safeNote,
        inspection,
      });
      await applyClaimOutcome(res, secret);
    } catch (err) {
      if (isPasskeyCancellation(err)) return;
      setClaimError(errorMessage(err));
    } finally {
      setClaiming(false);
      setOnboardingAction(null);
    }
  }, [
    applyClaimOutcome,
    balanceId,
    claiming,
    ephemeralSecret,
    inspection,
    linkNetwork,
    resolveSecret,
    safeNote,
  ]);

  const handleRetryReserveRelease = useCallback(async () => {
    if (!claimedResult || claimedResult.reserveReleased || retryingReserve) return;
    const secret = ephemeralSecret ?? (await resolveSecret());
    if (!secret) {
      setClaimedResult((prev) =>
        prev
          ? {
              ...prev,
              reserveReleaseError:
                'The link bearer secret is no longer in memory. Reopen the original claim link to release the 1 XLM reserve.',
            }
          : prev,
      );
      return;
    }

    setRetryingReserve(true);
    try {
      await requirePasskey();
      const signer = await requireSigner();
      const outcome = await retryReleaseClaimReserve({
        signer,
        ephemeralSecret: secret,
      });
      if (outcome.released) {
        await dismissPendingClaim(balanceId || undefined);
        setEphemeralSecret(null);
        setPendingCheckpoint(null);
        setClaimedResult((prev) =>
          prev
            ? {
                ...prev,
                reserveReleased: true,
                reserveReleaseTxHash: outcome.txHash ?? prev.reserveReleaseTxHash,
                reserveReleaseError: undefined,
              }
            : prev,
        );
      } else {
        setClaimedResult((prev) =>
          prev
            ? {
                ...prev,
                reserveReleased: false,
                reserveReleaseError: outcome.error,
              }
            : prev,
        );
      }
    } catch (err) {
      if (isPasskeyCancellation(err)) return;
      setClaimedResult((prev) =>
        prev
          ? {
              ...prev,
              reserveReleased: false,
              reserveReleaseError: errorMessage(err),
            }
          : prev,
      );
    } finally {
      setRetryingReserve(false);
    }
  }, [balanceId, claimedResult, ephemeralSecret, resolveSecret, retryingReserve]);

  const assetVerification = useMemo(() => {
    if (!inspection?.assetCode) {
      return { verified: false, issuerName: null as string | null };
    }
    const code = inspection.assetCode;
    const issuer = inspection.assetIssuer;
    if (code.toUpperCase() === 'XLM' && !issuer) {
      return { verified: true, issuerName: 'Stellar' };
    }
    const reg = verifiedAsset(code, issuer, activeNetName);
    const expectedIssuer = getAssetIssuer(code, activeNetName);
    if (reg && issuer && expectedIssuer === issuer) {
      return { verified: true, issuerName: reg.issuerName };
    }
    return { verified: false, issuerName: null };
  }, [activeNetName, inspection?.assetCode, inspection?.assetIssuer]);

  if (claimedResult) {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="claim-screen">
        <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
          <FlowHeader title="Claimed" onBack={handleDismiss} />
          <View style={styles.doneWrap}>
            <SuccessAnimation
              title={
                claimedResult.reserveReleased
                  ? 'Funds claimed'
                  : 'Funds delivered — reserve still held'
              }
              subtitle={`${claimedResult.amount} ${claimedResult.assetCode} added to your Spending account`}
            />
            {!claimedResult.reserveReleased ? (
              <View
                style={[styles.card, styles.reserveWarningCard]}
                testID="claim-reserve-release-warning"
              >
                <Text style={styles.reserveWarningTitle}>
                  1 XLM sponsor reserve was not released yet
                </Text>
                <Text style={styles.reserveWarningText}>
                  Your {claimedResult.amount} {claimedResult.assetCode} arrived in your Spending
                  account, but the second transaction to release the temporary 1 XLM sponsor
                  reserve failed. That 1 XLM stays held in reserve until released.
                </Text>
                {claimedResult.reserveReleaseError ? (
                  <Text style={styles.errorText} testID="claim-reserve-release-error">
                    {claimedResult.reserveReleaseError}
                  </Text>
                ) : null}
                <Pressable
                  testID="claim-retry-reserve-release"
                  accessibilityRole="button"
                  disabled={retryingReserve}
                  onPress={() => void handleRetryReserveRelease()}
                  style={({ pressed }) => [
                    styles.cta,
                    styles.fullWidthCta,
                    retryingReserve && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  {retryingReserve ? (
                    <ActivityIndicator color={colors.onAccent} />
                  ) : (
                    <Text style={styles.ctaText}>Retry release 1 XLM reserve</Text>
                  )}
                </Pressable>
              </View>
            ) : (
              <Text style={styles.reserveReleasedNote} testID="claim-reserve-released-ok">
                Temporary 1 XLM sponsor reserve released back to your Spending account.
              </Text>
            )}
            <View style={[styles.card, styles.hashCard]}>
              <Text style={styles.detailLabel}>Transaction hash</Text>
              <Text style={styles.hash} selectable testID="claim-tx-hash">
                {claimedResult.txHash}
              </Text>
              <Pressable
                testID="claim-copy-tx-hash"
                accessibilityRole="button"
                onPress={async () => {
                  await Clipboard.setStringAsync(claimedResult.txHash);
                  setCopiedHash(true);
                  setTimeout(() => setCopiedHash(false), 4000);
                }}
                style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
              >
                <Text style={styles.secondaryBtnText}>
                  {copiedHash ? 'Copied hash' : 'Copy transaction hash'}
                </Text>
              </Pressable>
            </View>
            <Pressable
              testID="claim-done-dismiss"
              accessibilityRole="button"
              onPress={handleDismiss}
              style={({ pressed }) => [
                claimedResult.reserveReleased ? styles.cta : styles.secondaryBtn,
                styles.fullWidthCta,
                pressed && styles.pressed,
              ]}
            >
              <Text
                style={
                  claimedResult.reserveReleased ? styles.ctaText : styles.secondaryBtnText
                }
              >
                Done
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  const isNonClaimableState =
    inspection &&
    (inspection.state === 'claimed_by_other' ||
      inspection.state === 'expired_and_reclaimed' ||
      inspection.state === 'not_found' ||
      inspection.state === 'status_unknown' ||
      inspection.state === 'network_mismatch');

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="claim-screen">
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <FlowHeader title="Claim link" onBack={handleDismiss} />

        {loading ? (
          <View style={styles.card} testID="claim-loading">
            <View style={styles.loadingRow}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.muted}>Reading claimable balance from Stellar…</Text>
            </View>
          </View>
        ) : loadError ? (
          <View style={styles.card}>
            <Text style={styles.errorText} testID="claim-load-error">
              {loadError}
            </Text>
            <Pressable
              testID="claim-retry-load"
              accessibilityRole="button"
              onPress={() => void loadOnChainState()}
              style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
            >
              <Text style={styles.secondaryBtnText}>Try again</Text>
            </Pressable>
            <Pressable
              testID="claim-leave"
              accessibilityRole="button"
              onPress={handleDismiss}
              style={styles.cancelBtn}
            >
              <Text style={styles.cancelText}>Leave without claiming</Text>
            </Pressable>
          </View>
        ) : isNonClaimableState && inspection ? (
          <View style={styles.card} testID="claim-consumed-card">
            <Text style={styles.consumedTitle} testID="claim-consumed-message">
              {inspection.message}
            </Text>
            {inspection.state === 'network_mismatch' && linkNetwork ? (
              <Pressable
                testID="claim-switch-network"
                accessibilityRole="button"
                onPress={() => void handleSwitchNetwork()}
                style={({ pressed }) => [styles.cta, pressed && styles.pressed]}
              >
                <Text style={styles.ctaText}>
                  Switch to {linkNetwork === 'mainnet' ? 'Stellar Mainnet' : 'Stellar Testnet'}
                </Text>
              </Pressable>
            ) : null}
            {inspection.state === 'status_unknown' ? (
              <Pressable
                testID="claim-retry-history"
                accessibilityRole="button"
                onPress={() => void loadOnChainState()}
                style={({ pressed }) => [styles.cta, pressed && styles.pressed]}
              >
                <Text style={styles.ctaText}>Try again</Text>
              </Pressable>
            ) : null}
            <Pressable
              testID="claim-leave"
              accessibilityRole="button"
              onPress={handleDismiss}
              style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
            >
              <Text style={styles.secondaryBtnText}>Close</Text>
            </Pressable>
          </View>
        ) : inspection ? (
          <>
            <View style={styles.card} testID="claim-details-card">
              <View style={styles.assetHeaderRow}>
                {assetVerification.verified && inspection.assetCode ? (
                  <View testID="claim-verified-icon">
                    <TokenIcon code={inspection.assetCode} size={36} />
                  </View>
                ) : null}
                <View style={styles.assetHeaderText}>
                  <Text
                    style={[
                      styles.overline,
                      !assetVerification.verified && styles.unverifiedBadge,
                    ]}
                    testID="claim-asset-badge"
                  >
                    {assetVerification.verified
                      ? `Verified asset · ${assetVerification.issuerName ?? 'Stellar'}`
                      : 'Unverified asset'}
                  </Text>
                  <Text style={styles.amountHero} testID="claim-verified-amount">
                    {inspection.amount} {inspection.assetCode}
                  </Text>
                </View>
              </View>

              {!assetVerification.verified && inspection.assetCode ? (
                <Text style={styles.unverifiedWarning} testID="claim-unverified-warning">
                  Anyone on Stellar can issue an asset named {inspection.assetCode}. This issuer is
                  not in Veil’s verified registry — claiming adds a trustline (0.5 XLM reserve) to
                  this issuer.
                </Text>
              ) : null}

              {inspection.assetIssuer ? (
                <Text style={styles.monoLine} testID="claim-verified-issuer">
                  Issuer: {inspection.assetIssuer}
                </Text>
              ) : null}
              {inspection.sponsor ? (
                <View style={styles.detailBlock}>
                  <Text style={styles.detailLabel}>From</Text>
                  <Text style={styles.monoAddress} selectable testID="claim-verified-sender">
                    {inspection.sponsor}
                  </Text>
                </View>
              ) : null}
              {inspection.expiryLabel ? (
                <Text style={styles.expiryLine} testID="claim-verified-expiry">
                  {inspection.expiryLabel}
                </Text>
              ) : null}
              {safeNote ? (
                <View style={styles.noteBox}>
                  <Text style={styles.detailLabel}>Sender note (unverified)</Text>
                  <Text style={styles.noteText} testID="claim-sender-note">
                    {safeNote}
                  </Text>
                </View>
              ) : null}
            </View>

            {pendingCheckpoint ? (
              <View style={styles.noticeCard} testID="claim-resuming-banner">
                <Text style={styles.noticeText}>
                  Resuming your pending claim from where you left off.
                </Text>
              </View>
            ) : null}

            <Text style={styles.privacyFootnote}>
              Claiming uses your Spending account to cover the network fee, which links that
              account to this claim on the public Stellar ledger.
            </Text>

            {claimError ? (
              <Text style={styles.errorBanner} testID="claim-submit-error">
                {claimError}
              </Text>
            ) : null}

            {fundingRequired ? (
              <View style={styles.card} testID="claim-funding-required">
                <Text style={styles.errorText}>{fundingRequired.reason}</Text>
                {fundingRequired.feePayerAddress ? (
                  <Text style={styles.monoAddress} selectable testID="claim-fee-payer-address">
                    {fundingRequired.feePayerAddress}
                  </Text>
                ) : null}
              </View>
            ) : null}

            {walletReady ? (
              <Pressable
                testID="claim-submit"
                accessibilityRole="button"
                disabled={claiming}
                onPress={() => void handleClaim()}
                style={({ pressed }) => [
                  styles.cta,
                  claiming && styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                {claiming ? (
                  <ActivityIndicator color={colors.onAccent} />
                ) : (
                  <Text style={styles.ctaText}>
                    Claim {inspection.amount}{' '}
                    {assetVerification.verified
                      ? inspection.assetCode
                      : `unverified ${inspection.assetCode}`}
                  </Text>
                )}
              </Pressable>
            ) : prfRefused ? (
              <View style={styles.card} testID="claim-prf-refused">
                <Text style={styles.reserveWarningTitle}>Passkey recovery check required</Text>
                <Text style={styles.muted} testID="claim-prf-refused-reason">
                  {prfRefused.reason}
                </Text>
                {prfRefused.issue === 'unsupported' ? (
                  <Pressable
                    testID="claim-open-create-wallet"
                    accessibilityRole="button"
                    disabled={claiming}
                    onPress={() => router.push('/create-wallet')}
                    style={({ pressed }) => [
                      styles.cta,
                      claiming && styles.disabled,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.ctaText}>Open Create Wallet</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    testID="claim-retry-prf"
                    accessibilityRole="button"
                    disabled={claiming}
                    onPress={() => void handleRetryPrf()}
                    style={({ pressed }) => [
                      styles.cta,
                      claiming && styles.disabled,
                      pressed && styles.pressed,
                    ]}
                  >
                    {claiming && onboardingAction === 'retry-prf' ? (
                      <ActivityIndicator color={colors.onAccent} />
                    ) : (
                      <Text style={styles.ctaText}>Try recovery check again</Text>
                    )}
                  </Pressable>
                )}
                <Pressable
                  testID="claim-sign-in-after-prf"
                  accessibilityRole="button"
                  disabled={claiming}
                  onPress={() => void handleSignInAndClaim()}
                  style={({ pressed }) => [
                    styles.secondaryBtn,
                    claiming && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  {claiming && onboardingAction === 'signin' ? (
                    <ActivityIndicator color={colors.textPrimary} />
                  ) : (
                    <Text style={styles.secondaryBtnText}>Sign in to an existing wallet</Text>
                  )}
                </Pressable>
              </View>
            ) : (
              <View style={styles.onboardingActions} testID="claim-no-wallet-actions">
                <View style={styles.noticeCard} testID="claim-origin-binding-notice">
                  <Text style={styles.noticeText}>{WALLET_CREATION_LIMITATION_MESSAGE}</Text>
                </View>

                {isClaimSponsorshipAvailable(activeNetName) ? (
                  <>
                    <Text style={styles.muted} testID="claim-sponsor-disclosure">
                      Creating a wallet here activates your Spending account (up to{' '}
                      {MAX_SPONSORED_CLAIM_XLM_PER_WALLET} XLM in refundable reserves on{' '}
                      {activeNetName}) and claims in one flow.
                    </Text>
                    <Pressable
                      testID="claim-create-and-claim"
                      accessibilityRole="button"
                      disabled={claiming}
                      onPress={() => void handleCreateAndClaim()}
                      style={({ pressed }) => [
                        styles.cta,
                        claiming && styles.disabled,
                        pressed && styles.pressed,
                      ]}
                    >
                      {claiming && onboardingAction === 'create' ? (
                        <ActivityIndicator color={colors.onAccent} />
                      ) : (
                        <Text style={styles.ctaText}>
                          Create wallet &amp; claim {inspection.amount}{' '}
                          {assetVerification.verified
                            ? inspection.assetCode
                            : `unverified ${inspection.assetCode}`}
                        </Text>
                      )}
                    </Pressable>
                  </>
                ) : (
                  <View style={styles.noticeCard} testID="claim-mainnet-sponsor-notice">
                    <Text style={styles.noticeText}>
                      {CLAIM_MAINNET_SPONSOR_UNAVAILABLE_MESSAGE}
                    </Text>
                  </View>
                )}

                <Pressable
                  testID="claim-sign-in-and-claim"
                  accessibilityRole="button"
                  disabled={claiming}
                  onPress={() => void handleSignInAndClaim()}
                  style={({ pressed }) => [
                    isClaimSponsorshipAvailable(activeNetName) ? styles.secondaryBtn : styles.cta,
                    claiming && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  {claiming && onboardingAction === 'signin' ? (
                    <ActivityIndicator
                      color={
                        isClaimSponsorshipAvailable(activeNetName)
                          ? colors.textPrimary
                          : colors.onAccent
                      }
                    />
                  ) : (
                    <Text
                      style={
                        isClaimSponsorshipAvailable(activeNetName)
                          ? styles.secondaryBtnText
                          : styles.ctaText
                      }
                    >
                      I already have a wallet — Sign in
                    </Text>
                  )}
                </Pressable>

                <Pressable
                  testID="claim-go-login"
                  accessibilityRole="button"
                  disabled={claiming}
                  onPress={() => router.push('/login')}
                  style={styles.cancelBtn}
                >
                  <Text style={styles.cancelText}>Sign in with address or backup</Text>
                </Pressable>
              </View>
            )}

            <Pressable
              testID="claim-cancel"
              accessibilityRole="button"
              onPress={handleDismiss}
              style={styles.cancelBtn}
            >
              <Text style={styles.cancelText}>Leave without claiming</Text>
            </Pressable>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    body: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 40, gap: 14 },
    card: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 16,
      padding: 18,
      gap: 10,
    },
    loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    assetHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    assetHeaderText: { flex: 1, gap: 2 },
    overline: {
      color: colors.textFaint,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 11,
      letterSpacing: 1.3,
      textTransform: 'uppercase',
    },
    unverifiedBadge: {
      color: colors.danger,
    },
    unverifiedWarning: {
      color: colors.danger,
      backgroundColor: colors.dangerSurface,
      fontFamily: fontFamily.body,
      fontSize: 12.5,
      lineHeight: 18,
      borderRadius: 10,
      padding: 10,
    },
    amountHero: {
      color: colors.textStrong,
      fontFamily: fontFamily.heading,
      fontSize: 34,
    },
    detailBlock: { gap: 3, marginTop: 4 },
    detailLabel: {
      color: colors.textFaint,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 11,
      letterSpacing: 1.1,
      textTransform: 'uppercase',
    },
    monoLine: {
      color: colors.textMuted,
      fontFamily: fontFamily.address,
      fontSize: 12,
    },
    monoAddress: {
      color: colors.textSecondary,
      fontFamily: fontFamily.address,
      fontSize: 12.5,
      lineHeight: 18,
    },
    expiryLine: {
      color: colors.accentText,
      fontFamily: fontFamily.bodyMedium,
      fontSize: 13,
      marginTop: 2,
    },
    noteBox: {
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: 10,
      gap: 4,
    },
    noteText: {
      color: colors.textPrimary,
      fontFamily: fontFamily.body,
      fontSize: 14,
      lineHeight: 20,
    },
    privacyFootnote: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 12,
      lineHeight: 18,
      textAlign: 'center',
    },
    consumedTitle: {
      color: colors.textPrimary,
      fontFamily: fontFamily.bodyMedium,
      fontSize: 15,
      lineHeight: 22,
    },
    muted: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 13.5,
      lineHeight: 20,
    },
    errorText: {
      color: colors.danger,
      fontFamily: fontFamily.body,
      fontSize: 13.5,
      lineHeight: 20,
    },
    errorBanner: {
      color: colors.danger,
      backgroundColor: colors.dangerSurface,
      fontFamily: fontFamily.body,
      fontSize: 13,
      borderRadius: 12,
      padding: 12,
    },
    onboardingActions: { gap: 10, marginTop: 4 },
    noticeCard: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    noticeText: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 12.5,
      lineHeight: 18,
    },
    cta: {
      backgroundColor: colors.accent,
      borderRadius: 100,
      paddingVertical: 16,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 4,
    },
    ctaText: {
      color: colors.onAccent,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
    },
    secondaryBtn: {
      borderWidth: 1,
      borderColor: colors.borderStrong,
      borderRadius: 100,
      paddingVertical: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    secondaryBtnText: {
      color: colors.textPrimary,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 14,
    },
    cancelBtn: { alignItems: 'center', paddingVertical: 10 },
    cancelText: {
      color: colors.textMuted,
      fontFamily: fontFamily.bodyMedium,
      fontSize: 13,
    },
    doneWrap: { alignItems: 'center', marginTop: 32, gap: 18 },
    reserveWarningCard: {
      alignSelf: 'stretch',
      borderColor: colors.danger,
      backgroundColor: colors.dangerSurface,
      gap: 10,
    },
    reserveWarningTitle: {
      color: colors.danger,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
    },
    reserveWarningText: {
      color: colors.textPrimary,
      fontFamily: fontFamily.body,
      fontSize: 13.5,
      lineHeight: 20,
    },
    reserveReleasedNote: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
      textAlign: 'center',
    },
    hashCard: { alignSelf: 'stretch', gap: 8 },
    fullWidthCta: { alignSelf: 'stretch' },
    hash: { color: colors.accent, fontFamily: fontFamily.address, fontSize: 12.5, lineHeight: 18 },
    disabled: { opacity: 0.45 },
    pressed: { opacity: 0.75 },
  });
