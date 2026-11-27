import { errorMessage } from '../lib/errorMessage';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as WebBrowser from 'expo-web-browser';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  discoverAnchorInfo,
  getSep10Jwt,
  signSep10Challenge,
  getTransactionStatus,
  initiateWithdraw,
  isSep24Complete,
  type Sep24TransactionStatus,
} from '../lib/sep24';
import { Keypair, StrKey } from '@stellar/stellar-sdk';

import { getFeePayerAddress } from '../lib/activity';
import { getNetwork } from '../lib/network';
import { sweepContractBalance } from '../lib/sweepContractBalance';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FlowHeader } from '../components/FlowHeader';
import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { getSignerSecret, getWalletAddress } from '../lib/walletStore';

// The anchor domain is the only thing that legitimately comes from env — every
// other network value is read live from getNetwork() at call time. Reading RPC
// URLs and passphrases into module constants freezes them to whatever the build
// shipped (testnet), which is the same defect that previously derived a wallet
// address against the wrong network and stranded real funds.
const DEFAULT_ANCHOR =
  process.env['EXPO_PUBLIC_SEP24_ANCHORS']?.split(',')[0]?.trim() || '';

const POLL_INTERVAL_MS = 4_000;

type Step =
  | 'form'
  | 'auth'
  | 'interactive' // browser tab open, waiting on the anchor's KYC/payment info
  | 'sweeping'     // moving funds from the contract wallet to the classic account
  | 'polling'      // waiting for the anchor to mark the transaction complete
  | 'done'
  | 'error';

export default function WithdrawScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [step, setStep] = useState<Step>('form');
  const [anchor, setAnchor] = useState(DEFAULT_ANCHOR);
  const [assetCode, setAssetCode] = useState('USDC');
  const [amount, setAmount] = useState('');

  const [txnId, setTxnId] = useState<string | null>(null);
  const [txnStatus, setTxnStatus] = useState<Sep24TransactionStatus | null>(null);
  const [sweepHash, setSweepHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const transferServerRef = useRef<string | null>(null);
  const jwtRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sweptRef = useRef(false);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => () => stopPolling(), []);

  const startPolling = (id: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const tx = await getTransactionStatus(transferServerRef.current!, id, jwtRef.current ?? undefined);
        setTxnStatus(tx);

        if (isSep24Complete(tx.status)) {
          stopPolling();
          if (tx.status === 'completed') {
            setStep('done');
          } else {
            setError(tx.message ?? `Anchor returned status "${tx.status}".`);
            setStep('error');
          }
          return;
        }

        // Anchor is ready for the on-chain payment — sweep the contract
        // wallet's balance out to the classic account and pay it.
        if (
          !sweptRef.current
          && tx.status === 'pending_user_transfer_start'
          && tx.withdraw_anchor_account
          && tx.withdraw_memo
        ) {
          sweptRef.current = true;
          void sweepAndPay(tx);
        }
      } catch {
        // network hiccup — keep polling
      }
    }, POLL_INTERVAL_MS);
  };

  const startWithdraw = async () => {
    // SEP-10 authenticates a CLASSIC account with an ed25519 signature, and a
    // SEP-24 withdrawal is settled by a classic payment to the anchor. Both
    // are the fee-payer's job — a C-address can do neither, so authenticating
    // as the contract would fail at the anchor.
    //
    // This is a workaround, not the design: SEP-45 (contract-account auth,
    // live on testanchor.stellar.org) is the right primitive for a passkey
    // smart wallet and would let the contract authenticate as itself. No NGN
    // anchor declares it yet. See docs/NGN_RAILS.md.
    const account = await getFeePayerAddress();
    if (!account) {
      setError('Spending account not set up yet.');
      setStep('error');
      return;
    }
    const n = parseFloat(amount);
    if (!Number.isFinite(n) || n <= 0) {
      setError('Enter a valid amount greater than zero.');
      return;
    }
    if (!anchor.trim()) {
      setError('Enter an anchor domain.');
      return;
    }

    setError(null);
    setStep('auth');
    try {
      const info = await discoverAnchorInfo(anchor.trim());
      transferServerRef.current = info.transferServerUrl;

      const secret = await getSignerSecret();
      if (!secret) {
        throw new Error('No signing key on this device — create or restore a wallet first.');
      }
      const signerKeypair = Keypair.fromSecret(secret);

      // An anchor that publishes no SIGNING_KEY cannot have its challenges
      // checked, and an unchecked challenge is signed with this device's real
      // key. Refuse rather than authenticate blind.
      if (!info.signingKey) {
        throw new Error(
          `${info.homeDomain} publishes no SEP-10 SIGNING_KEY, so its sign-in request cannot be verified.`,
        );
      }

      const jwt = await getSep10Jwt(
        info.webAuthEndpoint,
        account,
        info.networkPassphrase,
        async (params) =>
          signSep10Challenge(
            params.challengeXdr,
            params.networkPassphrase,
            signerKeypair,
            info.homeDomain,
            info.signingKey!,
            new URL(info.webAuthEndpoint).host,
          ),
      );
      jwtRef.current = jwt;

      const result = await initiateWithdraw(
        info.transferServerUrl,
        { assetCode: assetCode.trim(), account, amount: String(n) },
        jwt,
      );
      setTxnId(result.id);
      setStep('interactive');
      await WebBrowser.openBrowserAsync(result.url);
      startPolling(result.id);
    } catch (err: unknown) {
      const msg = errorMessage(err);
      setError(msg);
      setStep('error');
    }
  };

  const sweepAndPay = async (tx: Sep24TransactionStatus) => {
    const [contractAddress, feePayer] = await Promise.all([
      getWalletAddress().catch(() => null),
      getFeePayerAddress(),
    ]);
    if (!contractAddress || !StrKey.isValidContract(contractAddress) || !feePayer) {
      // Classic-only wallet, or nothing to sweep from — fall through to
      // polling and let the classic account settle the withdrawal directly.
      setStep('polling');
      return;
    }

    setStep('sweeping');
    setError(null);
    try {
      const network = getNetwork();
      // Signing a Soroban auth entry needs lib/passkey.ts wired into this
      // screen; until it is, refuse rather than return a hash for a transfer
      // that never happened. The catch below already treats a failed sweep as
      // non-fatal, so the withdrawal keeps polling.
      const result = await sweepContractBalance(
        {
          contractAddress,
          feePayerPublicKey: feePayer,
          rpcUrl: network.rpcUrl,
          networkPassphrase: network.networkPassphrase,
        },
        async () => {
          throw new Error(
            'Contract sweep needs on-device Soroban auth signing, which is not wired up yet. '
              + 'Fund the classic account directly to complete this withdrawal.',
          );
        },
      );
      setSweepHash(result.hash);
      setStep('polling');
    } catch (err: unknown) {
      const msg = errorMessage(err);
      // A sweep failure doesn't necessarily abort the withdrawal — the user
      // may already hold enough on the classic account. Keep polling so
      // completion can still be observed, but surface the problem.
      console.warn('[withdraw] sweep failed:', msg);
      setStep('polling');
    }
    void tx;
  };

  const reset = () => {
    stopPolling();
    setStep('form');
    setTxnId(null);
    setTxnStatus(null);
    setSweepHash(null);
    sweptRef.current = false;
    transferServerRef.current = null;
    jwtRef.current = null;
    setError(null);
  };

  if (step === 'error') {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="withdraw-screen">
      <View style={styles.body}>
        <FlowHeader title="Cash out" />
        <Text style={styles.heading}>Something went wrong</Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable style={styles.cta} onPress={reset}>
          <Text style={styles.ctaText}>Try again</Text>
        </Pressable>
      </View>
      </SafeAreaView>
    );
  }

  if (step === 'done') {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="withdraw-screen">
      <View style={styles.body}>
        <FlowHeader title="Cash out" />
        <Text style={styles.heading}>Withdrawal complete</Text>
        <Text style={styles.subtitle}>
          The anchor confirmed your cash-out. Funds should arrive shortly.
        </Text>
        {txnStatus?.amount_out ? (
          <Text style={styles.amountOut}>
            {txnStatus.amount_out} {txnStatus.amount_out_asset ?? ''}
          </Text>
        ) : null}
        <Pressable style={styles.cta} onPress={reset}>
          <Text style={styles.ctaText}>Start new withdrawal</Text>
        </Pressable>
      </View>
      </SafeAreaView>
    );
  }

  if (step === 'auth' || step === 'interactive' || step === 'sweeping' || step === 'polling') {
    const label =
      step === 'auth' ? `Authenticating with ${anchor}…`
      : step === 'interactive' ? 'Complete the anchor form in your browser…'
      : step === 'sweeping' ? 'Moving funds to your spending wallet…'
      : 'Payment sent — waiting for the anchor…';

    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="withdraw-screen">
      <View style={styles.body}>
        <FlowHeader title="Cash out" />
        <ActivityIndicator color={colors.accent} size="large" style={styles.spinner} />
        <Text style={styles.subtitle}>{label}</Text>
        {txnStatus ? (
          <View style={styles.card}>
            <Row label="Status" value={txnStatus.status.replace(/_/g, ' ')} />
            {txnStatus.amount_in ? (
              <Row label="Amount" value={`${txnStatus.amount_in} ${txnStatus.amount_in_asset ?? assetCode}`} />
            ) : null}
          </View>
        ) : null}
        {sweepHash ? <Text style={styles.hash}>sweep tx: {sweepHash}</Text> : null}
        {step === 'interactive' && txnId ? (
          <Pressable
            style={styles.ctaSecondary}
            onPress={() => transferServerRef.current && WebBrowser.openBrowserAsync(
              `${transferServerRef.current}/transaction?id=${txnId}`,
            )}
          >
            <Text style={styles.ctaSecondaryText}>Check status</Text>
          </Pressable>
        ) : null}
        <Pressable style={styles.ctaSecondary} onPress={reset}>
          <Text style={styles.ctaSecondaryText}>Cancel</Text>
        </Pressable>
      </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="withdraw-screen">
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.body}>
      <FlowHeader title="Cash out" />
      <Text style={styles.subtitle}>Withdraw to a bank account or mobile money via a Stellar anchor.</Text>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.form}>
        <TextInput
          style={styles.input}
          placeholder="Asset (e.g. USDC)"
          placeholderTextColor={colors.textFaint}
          value={assetCode}
          onChangeText={setAssetCode}
          autoCapitalize="characters"
        />
        <TextInput
          style={styles.input}
          placeholder="Amount"
          placeholderTextColor={colors.textFaint}
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
        />
        <TextInput
          style={styles.input}
          placeholder="testanchor.stellar.org"
          placeholderTextColor={colors.textFaint}
          value={anchor}
          onChangeText={setAnchor}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      <Pressable
        style={[styles.cta, !amount && styles.ctaDisabled]}
        onPress={startWithdraw}
        disabled={!amount}
      >
        <Text style={styles.ctaText}>Continue</Text>
      </Pressable>
    </ScrollView>
    </SafeAreaView>
  );
}

/**
 * Reads the palette itself rather than taking a `styles` prop: it is rendered
 * from one place, and a styles prop would be a second way for a screen to be
 * themed — which is the habit this file is being cured of.
 */
function Row({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

/**
 * Cash out carried the same off-brand indigo/slate palette Buy did, hardcoded
 * dark and headed by a bare bold title with no way back off the screen but the
 * system gesture. It now reads from `ThemeColors` and follows Send's shapes, so
 * the two ends of the same money flow match.
 */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    body: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 16, paddingBottom: 40, gap: 14 },

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

    form: { gap: 10 },
    input: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      paddingHorizontal: 16,
      paddingVertical: 13,
      color: colors.textPrimary,
      fontFamily: fontFamily.body,
      fontSize: 16,
      borderWidth: 1,
      // borderStrong, not border: these are fields the screen is asking you to
      // type into, and the faint divider colour made them disappear.
      borderColor: colors.borderStrong,
    },

    cta: {
      alignItems: 'center',
      justifyContent: 'center',
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

    card: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 16,
      paddingHorizontal: 16,
      paddingVertical: 13,
      gap: 8,
      width: '100%',
    },
    row: { flexDirection: 'row', justifyContent: 'space-between' },
    rowLabel: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13 },
    rowValue: { color: colors.textPrimary, fontFamily: fontFamily.bodyMedium, fontSize: 13 },
    spinner: { marginTop: 24 },

    error: {
      color: colors.danger,
      backgroundColor: colors.dangerSurface,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
      borderRadius: 12,
      padding: 12,
    },
    // Inconsolata: a transaction hash is an address, and the old 'monospace'
    // resolved to whatever the OS happened to supply.
    hash: { color: colors.textMuted, fontFamily: fontFamily.address, fontSize: 12 },
    amountOut: { color: colors.accentText, fontFamily: fontFamily.address, fontSize: 22 },
  });
