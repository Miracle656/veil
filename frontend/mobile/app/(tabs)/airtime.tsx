// NOTE: The maintainer asked that this screen live at app/airtime.tsx, not
// app/(tabs)/airtime.tsx. The file below is the content for the path requested
// by the task; the relocation should be applied when the file is moved.
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useMidActionDisconnect } from '../../lib/useMidActionDisconnect';
import {
  clearUnconfirmed,
  markUnconfirmed,
  UNCONFIRMED_MESSAGE,
  UNCONFIRMED_OFFLINE_MESSAGE,
  UNCONFIRMED_RESOLVED_MESSAGE,
  type UnconfirmedAction,
} from '../../lib/unconfirmed';

type ScreenState =
  | { status: 'idle' }
  | { status: 'signing' }
  | { status: 'unconfirmed'; action: UnconfirmedAction }
  | { status: 'confirmed'; hash: string }
  | { status: 'failed'; reason: string };

/**
 * Submits the airtime purchase. The single seam between the screen and the
 * airtime service, so disconnect behaviour stays testable.
 */
async function submitAirtime(params: {
  phone: string;
  amountStrops: number;
  networkPassphrase: string;
}): Promise<{ hash: string }> {
  const response = await fetch('https://api.veil.wallet/airtime/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    throw new Error(`Airtime submission rejected (${response.status})`);
  }
  const data = (await response.json()) as { hash?: string };
  if (!data.hash) throw new Error('Airtime submission returned no transaction hash');
  return { hash: data.hash };
}

/**
 * Resolves an unconfirmed airtime action by querying the airtime service for
 * the submitted transaction hash. Returns true if confirmed, false if provably
 * failed, and throws if the outcome is still unknown.
 */
async function resolveAirtime(action: UnconfirmedAction): Promise<boolean> {
  if (!action.hash) {
    // No hash means the submission never reached the server: provable failure.
    return false;
  }
  const response = await fetch(`https://api.veil.wallet/airtime/status/${encodeURIComponent(action.hash)}`);
  if (!response.ok) throw new Error('Could not resolve airtime action');
  const data = (await response.json()) as { status?: string };
  if (data.status === 'success') return true;
  if (data.status === 'failed') return false;
  // Unknown or pending statuses are treated as still pending, never as failed.
  throw new Error('Airtime action still pending');
}

export default function AirtimeScreen() {
  const [state, setState] = useState<ScreenState>({ status: 'idle' });
  const [phone, setPhone] = useState('');
  const [amount, setAmount] = useState('1');
  const disconnect = useMidActionDisconnect();

  const resolvePending = useCallback(async () => {
    if (state.status !== 'unconfirmed') return;
    try {
      const ok = await resolveAirtime(state.action);
      await clearUnconfirmed(state.action.id);
      disconnect.markActionSettled();
      if (ok) {
        setState({ status: 'confirmed', hash: state.action.hash ?? '' });
      } else {
        setState({ status: 'failed', reason: 'The airtime purchase did not go through.' });
      }
    } catch {
      // Still pending: keep the unconfirmed state and retry on next reconnect.
    }
  }, [state, disconnect]);

  useEffect(() => {
    return disconnect.onLineRecovered(() => {
      void resolvePending();
    });
  }, [disconnect, resolvePending]);

  const handlePurchase = useCallback(async () => {
    const trimmed = phone.trim();
    const strops = Math.round(Number(amount) * 10_000_000);
    if (!trimmed || !Number.isFinite(strops) || strops <= 0) return;

    disconnect.reset();
    setState({ status: 'signing' });

    // Step 1: passkey ceremony, on-device, no network needed.
    try {
      await signWithPasskey();
    } catch (err) {
      // Nothing was submitted, so this is a provable failure.
      setState({ status: 'failed', reason: err instanceof Error ? err.message : 'Signing was cancelled.' });
      return;
    }

    // Step 2: ceremony complete. From here, a network drop cannot mean "failed".
    disconnect.markCeremonyComplete();

    const actionId = `airtime:${Date.now()}`;
    try {
      const result = await submitAirtime({
        phone: trimmed,
        amountStrops: strops,
        networkPassphrase: 'Test Stellar Network ; September 2015',
      });
      disconnect.markActionSettled();
      setState({ status: 'confirmed', hash: result.hash });
    } catch {
      // Whether the submission reached the server is unknown: unconfirmed, not failed.
      const action = await markUnconfirmed({
        id: actionId,
        kind: 'airtime',
        summary: `Airtime for ${trimmed} (${amount} XLM)`,
        networkPassphrase: 'Test Stellar Network ; September 2015',
      });
      setState({ status: 'unconfirmed', action });
    }
  }, [disconnect, phone, amount]);

  const busy = state.status === 'signing';

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <View style={styles.panel}>
        <Text style={styles.eyebrow}>Airtime</Text>
        <Text style={styles.lede}>Buy airtime with your passkey wallet.</Text>

        <TextInput
          style={styles.input}
          value={phone}
          onChangeText={setPhone}
          placeholder="Phone number"
          keyboardType="phone-pad"
        />
        <TextInput
          style={styles.input}
          value={amount}
          onChangeText={setAmount}
          placeholder="Amount (XLM)"
          keyboardType="decimal-pad"
        />

        <Pressable style={[busy && styles.buttonDisabled, styles.button]} disabled={busy} onPress={handlePurchase}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Purchase</Text>}
        </Pressable>

        {state.status === 'unconfirmed' ? (
          <View style={styles.warning}>
            <Text style={styles.warningTitle}>Unconfirmed</Text>
            <Text style={styles.warningBody}>
              {disconnect.isOffline ? UNCONFIRMED_OFFLINE_MESSAGE : UNCONFIRMED_MESSAGE}
            </Text>
          </View>
        ) : null}

        {state.status === 'confirmed' ? (
          <View style={styles.success}>
            <Text style={styles.successTitle}>Confirmed</Text>
            <Text style={styles.successBody}>{UNCONFIRMED_RESOLVED_MESSAGE}</Text>
            <Text style={styles.hash}>{state.hash}</Text>
          </View>
        ) : null}

        {state.status === 'failed' ? (
          <View style={styles.error}>
            <Text style={styles.errorTitle}>Failed</Text>
            <Text style={styles.errorBody}>{state.reason}</Text>
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

/** Passkey ceremony placeholder kept so the state machine is readable. */
async function signWithPasskey(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

const styles = StyleSheet.create({
  panel: { flex: 1, padding: 24, gap: 12 },
  eyebrow: { color: '#94a3b8', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 },
  lede: { color: '#e2e8f0', fontSize: 16 },
  input: { backgroundColor: '#1e293b', color: '#e2e8f0', borderRadius: 10, padding: 12 },
  button: { backgroundColor: '#6366f1', borderRadius: 10, padding: 14, alignItems: 'center' },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontWeight: '600' },
  warning: { backgroundColor: '#3b2f10', borderColor: '#f59e0b', borderWidth: 1, borderRadius: 10, padding: 12, gap: 4 },
  warningTitle: { color: '#f59e0b', fontWeight: '700' },
  warningBody: { color: '#fde470' },
  success: { backgroundColor: '#0b3a20', borderColor: '#22c55e', borderWidth: 1, borderRadius: 10, padding: 12, gap: 4 },
  successTitle: { color: '#22c55e', fontWeight: '700' },
  successBody: { color: '#bbf7d0' },
  error: { backgroundColor: '#3f1b1b', borderColor: '#ef4444', borderWidth: 1, borderRadius: 10, padding: 12, gap: 4 },
  errorTitle: { color: '#ef4444', fontWeight: '700' },
  errorBody: { color: '#fecaca' },
  hash: { color: '#e2e8f0', fontFamily: 'monospace', fontSize: 12 },
});
