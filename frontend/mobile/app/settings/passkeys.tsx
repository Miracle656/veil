/**
 * Passkeys — the keys that can authorise this wallet on chain, and adding one.
 *
 * Adding a passkey here is NOT register(). The first version of this screen
 * called the SDK's register(), which overwrites the wallet address, credential
 * id and public key this device is bound to — repointing it at a new, empty
 * wallet and a different fee payer — and then failed anyway, because the SDK
 * sent a four-element signature where the contract requires five.
 *
 * Both halves are fixed underneath this screen:
 *
 *  - lib/addPasskeySigner creates the new credential under a fresh user handle,
 *    keeps it in its own store (lib/additionalSigners, guarded so it cannot
 *    write the primary binding), and submits `add_signer` approved by the
 *    existing passkey through the same five-element ceremony every spend uses.
 *  - The new key counts as added only once the wallet's on-chain signer list
 *    shows it. Until then it is listed as "not finished", with a way to finish.
 *
 * The other device then uses "Sign in with wallet address" and its new passkey.
 * The wallet contract stores one WebAuthn origin, so that device must run the
 * Veil app on the same platform as this one; the screen says so up front.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FlowHeader } from '../../components/FlowHeader';
import { useTheme } from '../../hooks/useTheme';
import { addPasskeySigner, finishPendingSigner } from '../../lib/addPasskeySigner';
import { forgetPendingSigner, listAdditionalSigners, type AdditionalSigner } from '../../lib/additionalSigners';
import { isWalletDeployed } from '../../lib/contractSpend';
import { errorMessage } from '../../lib/errorMessage';
import { passkeyFailureMessage } from '../../lib/passkeyOutcome';
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

type AddState =
  | { kind: 'idle' }
  /** The user has to read what adding does before it happens. */
  | { kind: 'confirm' }
  | { kind: 'working'; label: string }
  | { kind: 'done'; message: string }
  | { kind: 'error'; message: string };

function shortKey(publicKey: string): string {
  return publicKey.length > 20 ? `${publicKey.slice(0, 10)}…${publicKey.slice(-8)}` : publicKey;
}

/** A failure message for the add flow; null when the user simply cancelled. */
function addFailure(error: unknown): string | null {
  const passkey = passkeyFailureMessage(error);
  if (passkey === null) return null;
  return passkey || errorMessage(error);
}

export default function PasskeysScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [signers, setSigners] = useState<WalletSigner[]>([]);
  const [saved, setSaved] = useState<AdditionalSigner[]>([]);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [add, setAdd] = useState<AddState>({ kind: 'idle' });
  const [thisDeviceKey, setThisDeviceKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      setSaved(await listAdditionalSigners().catch(() => []));
      const address = await getWalletAddress();
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
      .catch(() => undefined);
  }, [load]);

  const runAdd = useCallback(async () => {
    setAdd({ kind: 'working', label: 'Create the new passkey, then approve with this one…' });
    try {
      const { signer } = await addPasskeySigner();
      setAdd(
        signer.status === 'active'
          ? { kind: 'done', message: `Added as passkey #${signer.signerIndex}. Your wallet address and fee account are unchanged.` }
          : { kind: 'done', message: 'Sent. The wallet has not listed the new passkey yet — use “Finish adding” below in a moment.' },
      );
    } catch (err) {
      const message = addFailure(err);
      setAdd(message === null ? { kind: 'idle' } : { kind: 'error', message });
    } finally {
      void load();
    }
  }, [load]);

  const runFinish = useCallback(
    async (credentialId: string) => {
      setAdd({ kind: 'working', label: 'Checking the wallet’s signers…' });
      try {
        const { signer } = await finishPendingSigner(credentialId);
        setAdd(
          signer.status === 'active'
            ? { kind: 'done', message: `Added as passkey #${signer.signerIndex}.` }
            : { kind: 'done', message: 'Still not listed on the wallet. Try again in a moment.' },
        );
      } catch (err) {
        const message = addFailure(err);
        setAdd(message === null ? { kind: 'idle' } : { kind: 'error', message });
      } finally {
        void load();
      }
    },
    [load],
  );

  const runForget = useCallback(
    async (credentialId: string) => {
      try {
        await forgetPendingSigner(credentialId);
        setAdd({ kind: 'idle' });
      } catch (err) {
        setAdd({ kind: 'error', message: errorMessage(err) });
      } finally {
        void load();
      }
    },
    [load],
  );

  const savedByKey = useMemo(() => new Map(saved.map((s) => [s.publicKey, s])), [saved]);
  const pending = saved.filter((s) => s.status === 'pending');
  const busy = add.kind === 'working';

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
              controls it; the signer list appears here after that first transaction, and you can
              add a second passkey then.
            </Text>
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
              const key = signer.publicKey.toLowerCase();
              const isThisDevice = thisDeviceKey !== null && key === thisDeviceKey;
              const isAdded = savedByKey.has(key);
              return (
                <View key={signer.index} style={styles.signerRow}>
                  <View style={styles.signerText}>
                    <Text style={styles.signerTitle}>
                      Passkey #{signer.index}
                      {isThisDevice ? ' · this device' : isAdded ? ' · added from here' : ''}
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

        {pending.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Not finished</Text>
            <Text style={styles.hint}>
              These passkeys were created but the wallet does not list them yet, so they cannot
              sign. Finishing checks the wallet first and never adds a key twice.
            </Text>
            {pending.map((signer) => (
              <View key={signer.credentialId} style={styles.pendingRow}>
                <Text style={styles.mono}>{shortKey(signer.publicKey)}</Text>
                <View style={styles.rowActions}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => void runFinish(signer.credentialId)}
                    style={({ pressed }) => [styles.secondary, styles.flex, pressed && styles.pressed]}
                  >
                    <Text style={styles.secondaryText}>Finish adding</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => void runForget(signer.credentialId)}
                    style={({ pressed }) => [styles.secondary, styles.flex, pressed && styles.pressed]}
                  >
                    <Text style={styles.secondaryText}>Forget</Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {state.kind === 'ready' ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Add another device</Text>
            {add.kind === 'confirm' ? (
              <>
                <Text style={styles.hint}>
                  This adds a second passkey to this same wallet. It does not replace the passkey on
                  this phone, and your wallet address and fee account stay exactly as they are.
                </Text>
                <Text style={styles.hint}>
                  1. Your phone asks where to save the new passkey — pick the other phone, tablet or
                  security key.{'\n'}2. Approve with this phone&apos;s passkey. A small network fee
                  is paid from your fee account.{'\n'}3. On the other device, open Veil and choose
                  “Sign in with wallet address”.
                </Text>
                <Text style={styles.hint}>
                  The other device must run the Veil app on the same kind of phone as this one: the
                  wallet accepts passkeys from one app platform only, and the web wallet cannot sign
                  for it.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void runAdd()}
                  style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
                >
                  <Text style={styles.primaryText}>Add a second passkey</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setAdd({ kind: 'idle' })}
                  style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
                >
                  <Text style={styles.secondaryText}>Cancel</Text>
                </Pressable>
              </>
            ) : add.kind === 'working' ? (
              <>
                <ActivityIndicator color={colors.accent} />
                <Text style={styles.hint}>{add.label}</Text>
              </>
            ) : (
              <>
                {add.kind === 'done' ? <Text style={styles.hint}>{add.message}</Text> : null}
                {add.kind === 'error' ? <Text style={styles.error}>{add.message}</Text> : null}
                <Text style={styles.hint}>
                  Give another phone, tablet or security key its own passkey for this wallet, so
                  losing one device does not lock you out.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setAdd({ kind: 'confirm' })}
                  style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
                >
                  <Text style={styles.secondaryText}>Add a passkey</Text>
                </Pressable>
              </>
            )}
          </View>
        ) : null}

        <Text style={styles.footnote}>
          Your encrypted backup (Settings → Wallet backup) still restores this wallet on a new phone
          if every passkey is lost.
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
    error: { fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19, color: colors.danger },
    signerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
    },
    signerText: { flex: 1, gap: 3 },
    signerTitle: { fontFamily: fontFamily.bodyMedium, fontSize: 15, color: colors.textPrimary },
    mono: { fontFamily: fontFamily.address, fontSize: 12, color: colors.textMuted },
    pendingRow: { gap: 8 },
    rowActions: { flexDirection: 'row', gap: 8 },
    flex: { flex: 1 },
    primary: {
      alignItems: 'center',
      paddingVertical: 12,
      borderRadius: 100,
      backgroundColor: colors.accent,
    },
    primaryText: { fontFamily: fontFamily.bodySemiBold, fontSize: 14, color: colors.onAccent },
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
