import { errorMessage } from '../lib/errorMessage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Keypair } from '@stellar/stellar-sdk';

import {
  discoverAnchorInfo,
  getSep10Jwt,
  getTransactionStatus,
  initiateDeposit,
  isSep24Complete,
  signSep10Challenge,
  type Sep24TransactionStatus,
} from '../lib/sep24';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FlowHeader } from '../components/FlowHeader';
import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { getSignerSecret, getWalletAddress } from '../lib/walletStore';

const FALLBACK_ADDRESS = process.env['EXPO_PUBLIC_FEE_PAYER_ADDRESS']?.trim() || '';
const DEFAULT_ANCHOR_DOMAIN = process.env['EXPO_PUBLIC_SEP24_ANCHOR_DOMAIN']?.trim() || '';

/**
 * Authenticate with the anchor if it advertises a SEP-10 endpoint.
 *
 * Most anchors reject `deposit/interactive` without a JWT. Returns `undefined`
 * when the anchor publishes no `WEB_AUTH_ENDPOINT`, in which case the deposit is
 * attempted unauthenticated and the anchor's own error is surfaced.
 */
async function authenticate(
  webAuthEndpoint: string,
  account: string,
  networkPassphrase: string,
  homeDomain: string,
  signingKey: string | undefined,
): Promise<string | undefined> {
  if (!webAuthEndpoint) return undefined;

  // An anchor that publishes no SIGNING_KEY cannot have its challenges checked,
  // and an unchecked challenge is signed with this device's real key. Refuse
  // rather than authenticate blind.
  if (!signingKey) {
    throw new Error(
      `${homeDomain} publishes no SEP-10 SIGNING_KEY, so its sign-in request cannot be verified.`,
    );
  }

  const secret = await getSignerSecret();
  if (!secret) {
    throw new Error('No signing key on this device — create or restore a wallet first.');
  }
  const signerKeypair = Keypair.fromSecret(secret);

  return getSep10Jwt(webAuthEndpoint, account, networkPassphrase, async (params) =>
    signSep10Challenge(
      params.challengeXdr,
      params.networkPassphrase,
      signerKeypair,
      homeDomain,
      signingKey,
      new URL(webAuthEndpoint).host,
    ),
  );
}

type Step = 'form' | 'connecting' | 'pending' | 'success' | 'error';

const POLL_INTERVAL_MS = 5_000;

export default function BuyScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [anchorDomain, setAnchorDomain] = useState(DEFAULT_ANCHOR_DOMAIN);
  const [assetCode, setAssetCode] = useState('XLM');
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<Step>('form');
  const [error, setError] = useState<string | null>(null);

  const [transferServerUrl, setTransferServerUrl] = useState<string | null>(null);
  const [txnId, setTxnId] = useState<string | null>(null);
  const [txnStatus, setTxnStatus] = useState<Sep24TransactionStatus | null>(null);
  const [account, setAccount] = useState<string>(FALLBACK_ADDRESS);

  useEffect(() => {
    let cancelled = false;
    getWalletAddress()
      .then((address) => {
        if (!cancelled && address) setAccount(address);
      })
      .catch(() => {
        // Leave the env fallback in place; handleBuy surfaces the missing account.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (server: string, id: string) => {
      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          const status = await getTransactionStatus(server, id);
          setTxnStatus(status);
          if (status.status === 'completed') {
            stopPolling();
            setStep('success');
          } else if (isSep24Complete(status.status)) {
            stopPolling();
          }
        } catch {
          // Polling errors are soft — keep trying until the user backs out.
        }
      }, POLL_INTERVAL_MS);
    },
    [stopPolling]
  );

  useEffect(() => () => stopPolling(), [stopPolling]);

  const handleBuy = async () => {
    if (!anchorDomain.trim()) {
      setError('Enter the anchor domain.');
      setStep('error');
      return;
    }

    setStep('connecting');
    setError(null);
    try {
      const resolved = (await getWalletAddress()) || FALLBACK_ADDRESS;
      if (!resolved) {
        throw new Error('Spending wallet not set up yet. Fund your wallet first.');
      }

      const {
        transferServerUrl: server,
        webAuthEndpoint,
        networkPassphrase,
        homeDomain,
        signingKey,
      } = await discoverAnchorInfo(anchorDomain.trim());
      setTransferServerUrl(server);

      const jwt = await authenticate(
        webAuthEndpoint,
        resolved,
        networkPassphrase,
        homeDomain,
        signingKey,
      );

      const deposit = await initiateDeposit(
        server,
        {
          assetCode: assetCode.trim() || 'XLM',
          account: resolved,
          amount: amount.trim() || undefined,
        },
        jwt,
      );
      setTxnId(deposit.id);

      // Launch the anchor's interactive flow in an in-app browser session and
      // return to the app once the user finishes (or dismisses) it.
      const redirectUrl = Linking.createURL('buy');
      await WebBrowser.openAuthSessionAsync(deposit.url, redirectUrl);

      setStep('pending');
      startPolling(server, deposit.id);
    } catch (err: unknown) {
      setError(errorMessage(err));
      setStep('error');
    }
  };

  const checkStatusNow = async () => {
    if (!transferServerUrl || !txnId) return;
    try {
      const status = await getTransactionStatus(transferServerUrl, txnId);
      setTxnStatus(status);
      if (status.status === 'completed') {
        stopPolling();
        setStep('success');
      }
    } catch (err: unknown) {
      setError(errorMessage(err));
    }
  };

  const reset = () => {
    stopPolling();
    setStep('form');
    setError(null);
    setTxnId(null);
    setTxnStatus(null);
    setTransferServerUrl(null);
  };

  if (step === 'success') {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="buy-screen">
      <View style={styles.body}>
        <FlowHeader title="Buy" />
        <Text style={styles.heading}>Deposit confirmed</Text>
        <Text style={styles.subtitle}>
          Your funds are on their way. It may take a few minutes for the balance to appear.
        </Text>
        {txnStatus?.amount_in && (
          <Text style={styles.amount}>
            +{txnStatus.amount_in} {txnStatus.amount_in_asset ?? assetCode}
          </Text>
        )}
        <Pressable style={styles.cta} onPress={reset}>
          <Text style={styles.ctaText}>Buy again</Text>
        </Pressable>
      </View>
      </SafeAreaView>
    );
  }

  if (step === 'pending') {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="buy-screen">
      <View style={styles.body}>
        <FlowHeader title="Buy" />
        <Text style={styles.heading}>Waiting for the anchor</Text>
        <Text style={styles.subtitle}>
          Complete the deposit in the browser window. Come back here when you&apos;re done.
        </Text>
        {txnStatus && (
          <View style={styles.card}>
            <Text style={styles.rowLabel}>Status</Text>
            <Text style={styles.rowValue}>{txnStatus.status}</Text>
          </View>
        )}
        <ActivityIndicator color={colors.accent} style={styles.spinner} />
        <Pressable style={styles.ctaSecondary} onPress={checkStatusNow}>
          <Text style={styles.ctaSecondaryText}>Check status</Text>
        </Pressable>
        <Pressable style={styles.linkBtn} onPress={reset}>
          <Text style={styles.linkText}>Cancel</Text>
        </Pressable>
      </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="buy-screen">
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.body}>
      <FlowHeader title="Buy" />
      <Text style={styles.subtitle}>Bring fiat into your wallet through a SEP-24 anchor.</Text>

      {!account && (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>
            Spending wallet not set up yet. Fund your wallet first so the anchor knows where to
            send your deposit.
          </Text>
        </View>
      )}

      <View style={styles.form}>
        <Text style={styles.label}>ANCHOR DOMAIN</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. testanchor.stellar.org"
          placeholderTextColor={colors.textFaint}
          value={anchorDomain}
          onChangeText={setAnchorDomain}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <View style={styles.row}>
          <View style={styles.rowFieldFlex}>
            <Text style={styles.label}>AMOUNT (OPTIONAL)</Text>
            <TextInput
              style={styles.input}
              placeholder="Amount"
              placeholderTextColor={colors.textFaint}
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
            />
          </View>
          <View style={styles.rowFieldAsset}>
            <Text style={styles.label}>ASSET</Text>
            <TextInput
              style={styles.input}
              placeholder="Asset"
              placeholderTextColor={colors.textFaint}
              value={assetCode}
              onChangeText={setAssetCode}
              autoCapitalize="characters"
            />
          </View>
        </View>

        <Pressable
          style={[styles.cta, step === 'connecting' && styles.ctaDisabled]}
          onPress={handleBuy}
          disabled={step === 'connecting'}
        >
          {step === 'connecting' ? (
            <ActivityIndicator color={colors.onAccent} />
          ) : (
            <Text style={styles.ctaText}>Connect to anchor</Text>
          )}
        </Pressable>
      </View>

      {/* USDY Explainer Card */}
      <View style={styles.rwaCard}>
        <Text style={styles.rwaTag}>TOKENIZED US TREASURIES</Text>
        <Text style={styles.rwaTitle}>USDY (Ondo US Dollar Yield)</Text>
        <Text style={styles.rwaDesc}>
          Understand what USDY is, how its value accrues, and its key risks before swapping or buying.
        </Text>
        <Pressable
          style={styles.rwaButton}
          onPress={() => router.push('/token/usdy' as any)}
        >
          <Text style={styles.rwaButtonText}>Learn what USDY is →</Text>
        </Pressable>
      </View>

      {step === 'error' && error && <Text style={styles.error}>{error}</Text>}
    </ScrollView>
    </SafeAreaView>
  );
}

/**
 * Buy was still wearing the indigo/slate palette the rest of the app left
 * behind (`#6366f1`, `#1e293b`, `#334155`), hardcoded dark, with its own
 * `fontWeight` headings instead of the brand faces. On a phone in light mode
 * it rendered as a dark slab in the middle of the wallet, and the one brand
 * colour on it — the gold on the USDY card — was the literal dark-mode hex, so
 * it lost its contrast against white.
 *
 * Everything below reads from `ThemeColors`, which is why it is a function
 * now: both palettes come from the same definition, so a light-mode value
 * cannot be forgotten. The shapes follow Send — the pill CTA, 16-radius cards
 * and inputs, Anton-weight overline labels — because Buy sits beside it on the
 * dashboard and the two should not look like different products.
 */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    body: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 16, paddingBottom: 40, gap: 14 },

    // Second-level heading inside a flow: FlowHeader already carries "Buy", so
    // this names the state rather than repeating the screen.
    heading: {
      color: colors.textStrong,
      fontFamily: fontFamily.heading,
      fontSize: 22,
      marginTop: 10,
    },
    subtitle: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 14.5,
      lineHeight: 21,
    },

    notice: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 14,
    },
    noticeText: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
    },

    form: { gap: 10 },
    label: {
      color: colors.textFaint,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: 1.4,
    },
    row: { flexDirection: 'row', gap: 10 },
    rowFieldFlex: { flex: 2, gap: 6 },
    rowFieldAsset: { flex: 1, gap: 6 },
    input: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      paddingHorizontal: 16,
      paddingVertical: 13,
      color: colors.textPrimary,
      fontFamily: fontFamily.body,
      fontSize: 16,
      borderWidth: 1,
      // borderStrong, not border: this is something the screen is asking you to
      // type into, and the faint divider colour made the fields disappear.
      borderColor: colors.borderStrong,
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
    ctaText: { color: colors.onAccent, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },
    ctaDisabled: { opacity: 0.4 },
    ctaSecondary: {
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceMd,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 100,
      paddingVertical: 17,
      marginTop: 8,
    },
    ctaSecondaryText: { color: colors.textPrimary, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },
    linkBtn: { alignItems: 'center', paddingVertical: 8 },
    linkText: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 14 },

    card: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 16,
      paddingHorizontal: 16,
      paddingVertical: 13,
      gap: 4,
    },
    rowLabel: {
      color: colors.textFaint,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: 1.4,
    },
    rowValue: { color: colors.textPrimary, fontFamily: fontFamily.bodyMedium, fontSize: 14 },
    spinner: { marginVertical: 4 },

    // Inconsolata, like every other figure in the app — the old 'monospace'
    // resolved to whatever the OS felt like and matched nothing.
    amount: { color: colors.accentText, fontFamily: fontFamily.address, fontSize: 22 },

    error: {
      color: colors.danger,
      backgroundColor: colors.dangerSurface,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
      borderRadius: 12,
      padding: 12,
    },

    rwaCard: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 16,
      padding: 16,
      gap: 6,
      marginTop: 8,
    },
    rwaTag: {
      color: colors.accentText,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 10,
      letterSpacing: 1.2,
      textTransform: 'uppercase',
    },
    rwaTitle: { color: colors.textStrong, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },
    rwaDesc: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
      marginBottom: 6,
    },
    rwaButton: {
      backgroundColor: colors.surfaceMd,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 100,
      paddingVertical: 9,
      paddingHorizontal: 14,
      alignSelf: 'flex-start',
    },
    rwaButtonText: { color: colors.accentText, fontFamily: fontFamily.bodySemiBold, fontSize: 12 },
  });
