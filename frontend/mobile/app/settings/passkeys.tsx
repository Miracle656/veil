/**
 * Passkeys — the keys that can authorise this wallet on chain.
 *
 * Read-only, deliberately. The first version of this screen had an "Add a
 * passkey" button that called the SDK's `register()`, and that call overwrites
 * `invisible_wallet_key_id`, `invisible_wallet_address` and
 * `invisible_wallet_public_key` in AsyncStorage — the exact keys walletStore
 * reads. It would have repointed the device at a different wallet address and a
 * credential whose PRF derives a different fee-payer G-account, stranding the
 * money, and then failed anyway: the SDK builds a 4-element signature vector
 * where the contract requires 5, so `addSigner` cannot succeed from here.
 *
 * Adding a second device needs the app to hold several credentials at once
 * without disturbing the primary binding. That is a piece of work, not a button,
 * so this screen shows what is registered and says plainly what is missing.
 */

import { Buffer } from 'buffer';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FlowHeader } from '../../components/FlowHeader';
import { useTheme } from '../../hooks/useTheme';
import { isWalletDeployed } from '../../lib/contractSpend';
import { errorMessage } from '../../lib/errorMessage';
import { recoverWalletPublicKey } from '../../lib/recoverPasskeyKey';
import { readSigners, type WalletSigner } from '../../lib/signers';
import type { ThemeColors } from '../../lib/theme';
import { getPasskeyPublicKey, getWalletAddress } from '../../lib/walletStore';
import { fontFamily } from '../../theme/typography';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  /** No contract on chain yet, so there is no signer list to read. */
  | { kind: 'undeployed' }
  | { kind: 'error'; message: string };

function shortKey(publicKey: string): string {
  return publicKey.length > 20 ? `${publicKey.slice(0, 10)}…${publicKey.slice(-8)}` : publicKey;
}

export default function PasskeysScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [signers, setSigners] = useState<WalletSigner[]>([]);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  // `undefined` while the secure store is still being read, so the repair card
  // below never flashes at someone whose key is simply not loaded yet.
  const [thisDeviceKey, setThisDeviceKey] = useState<string | null | undefined>(undefined);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [repair, setRepair] = useState<'idle' | 'running' | 'done' | 'failed'>('idle');

  /**
   * Recover the wallet's public key from the passkey itself.
   *
   * Offered only when nothing on this device has it, which is the state that
   * makes a funded wallet unspendable: `deploy()` needs the key, and WebAuthn
   * reveals it only at registration. One signature is enough to get it back.
   */
  const runRepair = useCallback(async () => {
    if (!walletAddress) return;
    setRepair('running');
    try {
      const key = await recoverWalletPublicKey(walletAddress);
      if (key) {
        setThisDeviceKey(Buffer.from(key).toString('hex').toLowerCase());
        setRepair('done');
      } else {
        setRepair('failed');
      }
    } catch {
      setRepair('failed');
    }
  }, [walletAddress]);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const address = await getWalletAddress();
      setWalletAddress(address);
      if (!address) {
        setState({ kind: 'error', message: 'No wallet on this device yet.' });
        return;
      }
      if (address.startsWith('C') && !(await isWalletDeployed(address))) {
        setSigners([]);
        setState({ kind: 'undeployed' });
        return;
      }
      setSigners(await readSigners(address));
      setState({ kind: 'ready' });
    } catch (err) {
      setState({ kind: 'error', message: errorMessage(err) });
    }
  }, []);

  useEffect(() => {
    void load();
    void getPasskeyPublicKey()
      .then((key) => setThisDeviceKey(key?.toLowerCase() ?? null))
      .catch(() => setThisDeviceKey(null));
  }, [load]);

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <FlowHeader title="Passkeys" />
      </View>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <Text style={styles.hint}>
          These are the keys registered on your wallet contract. Each one can authorise a payment.
        </Text>

        {state.kind === 'loading' ? (
          <View style={styles.card}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.hint}>Reading the wallet&apos;s signers…</Text>
          </View>
        ) : state.kind === 'undeployed' ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Not on chain yet</Text>
            <Text style={styles.hint}>
              This wallet is created on chain the first time it spends. Your passkey already
              controls it; the signer list appears here after that first transaction.
            </Text>
            {thisDeviceKey === null ? (
              <>
                <Text style={styles.hint}>
                  {repair === 'done'
                    ? 'Recovered. This wallet can be set up on chain now — try your payment again.'
                    : repair === 'failed'
                      ? 'That passkey does not match this wallet. Approve the prompt with the passkey this wallet was created with.'
                      : 'This device has no record of which passkey controls this wallet, so it can’t set it up on chain. Your passkey can prove it — one check fixes this for good.'}
                </Text>
                {repair === 'done' ? null : (
                  <Pressable
                    accessibilityRole="button"
                    disabled={repair === 'running'}
                    onPress={() => void runRepair()}
                    style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
                  >
                    <Text style={styles.secondaryText}>
                      {repair === 'running' ? 'Checking…' : 'Check with passkey'}
                    </Text>
                  </Pressable>
                )}
              </>
            ) : null}
          </View>
        ) : state.kind === 'error' ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Couldn&apos;t read your passkeys</Text>
            <Text style={styles.hint}>{state.message}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => void load()}
              style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
            >
              <Text style={styles.secondaryText}>Try again</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.card}>
            {signers.map((signer) => {
              const isThisDevice =
                thisDeviceKey !== null && signer.publicKey.toLowerCase() === thisDeviceKey;
              return (
                <View key={signer.index} style={styles.signerRow}>
                  <View style={styles.signerText}>
                    <Text style={styles.signerTitle}>
                      Passkey #{signer.index}
                      {isThisDevice ? ' · this device' : ''}
                    </Text>
                    <Text style={styles.mono}>{shortKey(signer.publicKey)}</Text>
                  </View>
                </View>
              );
            })}
            {signers.length === 0 ? (
              <Text style={styles.hint}>This wallet has no registered signers.</Text>
            ) : null}
          </View>
        )}

        <Text style={styles.footnote}>
          Registering a second device isn&apos;t available yet — it needs the app to hold more than
          one passkey at a time, which it can&apos;t do safely today. Until then, your encrypted
          backup (Settings → Wallet backup) is what restores this wallet on a new phone.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    header: { paddingHorizontal: 20, paddingTop: 16 },
    content: { padding: 20, paddingBottom: 48, gap: 14 },
    card: {
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 16,
      padding: 18,
      gap: 12,
    },
    cardTitle: { fontFamily: fontFamily.bodySemiBold, fontSize: 16, color: colors.textStrong },
    hint: { fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19, color: colors.textMuted },
    signerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
    },
    signerText: { flex: 1, gap: 3 },
    signerTitle: { fontFamily: fontFamily.bodyMedium, fontSize: 15, color: colors.textPrimary },
    mono: { fontFamily: fontFamily.address, fontSize: 12, color: colors.textMuted },
    secondary: {
      alignItems: 'center',
      paddingVertical: 11,
      borderRadius: 100,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    secondaryText: { fontFamily: fontFamily.bodyMedium, fontSize: 14, color: colors.textPrimary },
    pressed: { opacity: 0.7 },
    footnote: {
      fontFamily: fontFamily.body,
      fontSize: 12,
      lineHeight: 18,
      color: colors.textFaint,
    },
  });
