import { useCallback, useEffect, useRef, useState } from 'react';
import * as Linking from 'expo-linking';
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
import { getSignerSecret, getWalletAddress } from '../lib/walletStore';

// Falls back to env so the screen can be exercised against a testnet anchor
// before a wallet exists on the device.
const FALLBACK_ADDRESS = process.env['EXPO_PUBLIC_FEE_PAYER_ADDRESS']?.trim() || '';
const DEFAULT_ANCHOR_DOMAIN = process.env['EXPO_PUBLIC_SEP24_ANCHOR_DOMAIN']?.trim() || 'testanchor.stellar.org';

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
): Promise<string | undefined> {
  if (!webAuthEndpoint) return undefined;

  const secret = await getSignerSecret();
  if (!secret) {
    throw new Error('No signing key on this device — create or restore a wallet first.');
  }
  const signerKeypair = Keypair.fromSecret(secret);

  return getSep10Jwt(webAuthEndpoint, account, networkPassphrase, async (params) =>
    signSep10Challenge(params.challengeXdr, params.networkPassphrase, signerKeypair),
  );
}

type Step = 'form' | 'connecting' | 'pending' | 'success' | 'error';

const POLL_INTERVAL_MS = 5_000;

export default function BuyScreen() {
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
      } = await discoverAnchorInfo(anchorDomain.trim());
      setTransferServerUrl(server);

      const jwt = await authenticate(webAuthEndpoint, resolved, networkPassphrase);

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
      setError(err instanceof Error ? err.message : 'Could not connect to anchor.');
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
      setError(err instanceof Error ? err.message : 'Could not fetch transaction status.');
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
      <View style={styles.container}>
        <Text style={styles.title}>Deposit confirmed</Text>
        <Text style={styles.subtitle}>
          Your funds are on their way. It may take a few minutes for the balance to appear.
        </Text>
        {txnStatus?.amount_in && (
          <Text style={styles.amount}>
            +{txnStatus.amount_in} {txnStatus.amount_in_asset ?? assetCode}
          </Text>
        )}
        <Pressable style={[styles.btn, styles.btnPrimary]} onPress={reset}>
          <Text style={styles.btnText}>Buy again</Text>
        </Pressable>
      </View>
    );
  }

  if (step === 'pending') {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Waiting for the anchor</Text>
        <Text style={styles.subtitle}>
          Complete the deposit in the browser window. Come back here when you&apos;re done.
        </Text>
        {txnStatus && (
          <View style={styles.card}>
            <Text style={styles.rowLabel}>Status</Text>
            <Text style={styles.rowValue}>{txnStatus.status}</Text>
          </View>
        )}
        <ActivityIndicator color="#6366f1" style={styles.spinner} />
        <Pressable style={[styles.btn, styles.btnSecondary]} onPress={checkStatusNow}>
          <Text style={styles.btnText}>Check status</Text>
        </Pressable>
        <Pressable style={styles.linkBtn} onPress={reset}>
          <Text style={styles.linkText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Buy</Text>
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
          placeholderTextColor="#64748b"
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
              placeholderTextColor="#64748b"
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
              placeholderTextColor="#64748b"
              value={assetCode}
              onChangeText={setAssetCode}
              autoCapitalize="characters"
            />
          </View>
        </View>

        <Pressable
          style={[styles.btn, styles.btnPrimary, step === 'connecting' && styles.btnDisabled]}
          onPress={handleBuy}
          disabled={step === 'connecting'}
        >
          {step === 'connecting' ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.btnText}>Connect to anchor</Text>
          )}
        </Pressable>
      </View>

      {step === 'error' && error && <Text style={styles.error}>{error}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: '#0B0B0F',
    padding: 24,
    gap: 16,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    color: '#9BA1A6',
    fontSize: 15,
  },
  notice: {
    backgroundColor: '#1e293b',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    padding: 14,
  },
  noticeText: {
    color: '#94a3b8',
    fontSize: 13,
    lineHeight: 18,
  },
  form: {
    gap: 10,
  },
  label: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  row: {
    flexDirection: 'row',
    gap: 10,
  },
  rowFieldFlex: {
    flex: 2,
    gap: 6,
  },
  rowFieldAsset: {
    flex: 1,
    gap: 6,
  },
  input: {
    backgroundColor: '#1e293b',
    borderRadius: 10,
    padding: 14,
    color: '#f1f5f9',
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  btn: {
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnPrimary: {
    backgroundColor: '#6366f1',
  },
  btnSecondary: {
    backgroundColor: '#334155',
  },
  btnDisabled: {
    opacity: 0.4,
  },
  btnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  linkBtn: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  linkText: {
    color: '#94a3b8',
    fontSize: 14,
  },
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 10,
    padding: 14,
    gap: 4,
  },
  rowLabel: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  rowValue: {
    color: '#f1f5f9',
    fontSize: 14,
    fontWeight: '600',
  },
  spinner: {
    marginVertical: 4,
  },
  amount: {
    color: '#a5b4fc',
    fontFamily: 'monospace',
    fontSize: 20,
    fontWeight: '700',
  },
  error: {
    color: '#f87171',
    fontSize: 13,
    backgroundColor: '#450a0a',
    borderRadius: 8,
    padding: 10,
  },
});
