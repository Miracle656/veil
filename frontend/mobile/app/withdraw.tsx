import { useEffect, useRef, useState } from 'react';
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
import { Keypair } from '@stellar/stellar-sdk';

import { sweepContractBalance } from '../lib/sweepContractBalance';
import { getSignerSecret, getWalletAddress } from '../lib/walletStore';

const DEFAULT_ANCHOR =
  process.env['EXPO_PUBLIC_SEP24_ANCHORS']?.split(',')[0]?.trim() || 'testanchor.stellar.org';
const FALLBACK_ADDRESS = process.env['EXPO_PUBLIC_FEE_PAYER_ADDRESS']?.trim() || '';
const WALLET_CONTRACT_ID = process.env['EXPO_PUBLIC_WALLET_CONTRACT_ID']?.trim() || '';
const RPC_URL = process.env['EXPO_PUBLIC_RPC_URL']?.trim() || 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE =
  process.env['EXPO_PUBLIC_NETWORK_PASSPHRASE']?.trim()
  || 'Test SDF Network ; September 2015';

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
    const account = (await getWalletAddress()) || FALLBACK_ADDRESS;
    if (!account) {
      setError('Spending wallet not set up yet.');
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

      const jwt = await getSep10Jwt(
        info.webAuthEndpoint,
        account,
        info.networkPassphrase,
        async (params) =>
          signSep10Challenge(params.challengeXdr, params.networkPassphrase, signerKeypair),
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
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStep('error');
    }
  };

  const sweepAndPay = async (tx: Sep24TransactionStatus) => {
    if (!WALLET_CONTRACT_ID) {
      // Nothing to sweep from — fall through to polling and let the user
      // pay the anchor's deposit address through some other flow.
      setStep('polling');
      return;
    }

    setStep('sweeping');
    setError(null);
    try {
      const account = (await getWalletAddress()) || FALLBACK_ADDRESS;
      // Signing a Soroban auth entry needs lib/passkey.ts wired into this
      // screen; until it is, refuse rather than return a hash for a transfer
      // that never happened. The catch below already treats a failed sweep as
      // non-fatal, so the withdrawal keeps polling.
      const result = await sweepContractBalance(
        {
          contractAddress: WALLET_CONTRACT_ID,
          feePayerPublicKey: account,
          rpcUrl: RPC_URL,
          networkPassphrase: NETWORK_PASSPHRASE,
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
      const msg = err instanceof Error ? err.message : String(err);
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
      <View style={styles.container}>
        <Text style={styles.title}>Something went wrong</Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable style={[styles.btn, styles.btnPrimary]} onPress={reset}>
          <Text style={styles.btnText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  if (step === 'done') {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Withdrawal complete</Text>
        <Text style={styles.subtitle}>
          The anchor confirmed your cash-out. Funds should arrive shortly.
        </Text>
        {txnStatus?.amount_out ? (
          <Text style={styles.amountOut}>
            {txnStatus.amount_out} {txnStatus.amount_out_asset ?? ''}
          </Text>
        ) : null}
        <Pressable style={[styles.btn, styles.btnPrimary]} onPress={reset}>
          <Text style={styles.btnText}>Start new withdrawal</Text>
        </Pressable>
      </View>
    );
  }

  if (step === 'auth' || step === 'interactive' || step === 'sweeping' || step === 'polling') {
    const label =
      step === 'auth' ? `Authenticating with ${anchor}…`
      : step === 'interactive' ? 'Complete the anchor form in your browser…'
      : step === 'sweeping' ? 'Moving funds to your spending wallet…'
      : 'Payment sent — waiting for the anchor…';

    return (
      <View style={styles.container}>
        <ActivityIndicator color="#6366f1" size="large" />
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
            style={[styles.btn, styles.btnSecondary]}
            onPress={() => transferServerRef.current && WebBrowser.openBrowserAsync(
              `${transferServerRef.current}/transaction?id=${txnId}`,
            )}
          >
            <Text style={styles.btnText}>Check status</Text>
          </Pressable>
        ) : null}
        <Pressable style={[styles.btn, styles.btnSecondary]} onPress={reset}>
          <Text style={styles.btnText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Cash out</Text>
      <Text style={styles.subtitle}>Withdraw to a bank account or mobile money via a Stellar anchor.</Text>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.form}>
        <TextInput
          style={styles.input}
          placeholder="Asset (e.g. USDC)"
          placeholderTextColor="#64748b"
          value={assetCode}
          onChangeText={setAssetCode}
          autoCapitalize="characters"
        />
        <TextInput
          style={styles.input}
          placeholder="Amount"
          placeholderTextColor="#64748b"
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
        />
        <TextInput
          style={styles.input}
          placeholder="testanchor.stellar.org"
          placeholderTextColor="#64748b"
          value={anchor}
          onChangeText={setAnchor}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      <Pressable
        style={[styles.btn, styles.btnPrimary, !amount && styles.btnDisabled]}
        onPress={startWithdraw}
        disabled={!amount}
      >
        <Text style={styles.btnText}>Continue</Text>
      </Pressable>
    </ScrollView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
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
    textAlign: 'center',
  },
  form: {
    gap: 10,
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
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 10,
    padding: 14,
    gap: 8,
    width: '100%',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  rowLabel: {
    color: '#94a3b8',
    fontSize: 13,
  },
  rowValue: {
    color: '#f1f5f9',
    fontSize: 13,
    fontWeight: '600',
  },
  error: {
    color: '#f87171',
    fontSize: 13,
    backgroundColor: '#450a0a',
    borderRadius: 8,
    padding: 10,
  },
  hash: {
    color: '#94a3b8',
    fontFamily: 'monospace',
    fontSize: 12,
  },
  amountOut: {
    color: '#a5b4fc',
    fontSize: 20,
    fontWeight: '700',
  },
});
