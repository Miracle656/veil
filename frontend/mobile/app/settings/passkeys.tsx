/**
 * Passkeys — wallet signers registered on chain and credentials saved locally.
 * Adding a signer uses its own SDK path; it never calls register() or replaces
 * this device's primary wallet binding.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { AdditionalSignerCredential } from '@veil/sdk';

import { FlowHeader } from '../../components/FlowHeader';
import { useTheme } from '../../hooks/useTheme';
import { isWalletDeployed } from '../../lib/contractSpend';
import { errorMessage } from '../../lib/errorMessage';
import { readSigners, type WalletSigner } from '../../lib/signers';
import type { ThemeColors } from '../../lib/theme';
import { getPasskeyPublicKey, getWalletAddress } from '../../lib/walletStore';
import { fontFamily } from '../../theme/typography';
import { useWallet } from '../../components/WalletProvider';

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
  const { wallet, session } = useWallet();
  const getAdditionalSignerCredentials = wallet.getAdditionalSignerCredentials;
  const registerAdditionalSigner = wallet.registerAdditionalSigner;
  const retryAdditionalSigner = wallet.retryAdditionalSigner;

  const [signers, setSigners] = useState<WalletSigner[]>([]);
  const [additionalCredentials, setAdditionalCredentials] = useState<AdditionalSignerCredential[]>([]);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [thisDeviceKey, setThisDeviceKey] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [retryingCredentialId, setRetryingCredentialId] = useState<string | null>(null);
  const [operationMessage, setOperationMessage] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const address = await getWalletAddress();
      setWalletAddress(address);
      const [primaryKey, localCredentials] = await Promise.all([
        getPasskeyPublicKey(),
        getAdditionalSignerCredentials(),
      ]);
      setThisDeviceKey(primaryKey?.toLowerCase() ?? null);
      setAdditionalCredentials(localCredentials);
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
  }, [getAdditionalSignerCredentials]);

  useEffect(() => {
    void load();
  }, [load]);

  const addPasskey = useCallback(async () => {
    if (!walletAddress) {
      setOperationError('No wallet is selected on this device.');
      return;
    }
    if (!session) {
      setOperationError('The fee payer is unavailable. Restore this wallet before adding a passkey.');
      return;
    }

    setAdding(true);
    setOperationError(null);
    setOperationMessage(null);
    try {
      const credential = await registerAdditionalSigner(
        session.signerKeypair,
        walletAddress,
        'Veil wallet signer',
      );
      setOperationMessage(
        `Passkey added as wallet signer #${credential.signerIndex}. Your wallet address and fee payer were not changed.`,
      );
      await load();
    } catch (err) {
      setOperationError(errorMessage(err));
      await load();
    } finally {
      setAdding(false);
    }
  }, [load, registerAdditionalSigner, session, walletAddress]);

  const confirmAddPasskey = useCallback(() => {
    Alert.alert(
      'Add a passkey to this wallet?',
      'This ADDS a signer to your existing wallet. It does not replace your current passkey, wallet address, or fee payer. The new passkey must be available on the device where you want to use it.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Add passkey', onPress: () => void addPasskey() },
      ],
    );
  }, [addPasskey]);

  const retryPendingPasskey = useCallback(async (credentialId: string) => {
    if (!walletAddress || !session) {
      setOperationError('Restore this wallet before retrying signer registration.');
      return;
    }
    setRetryingCredentialId(credentialId);
    setOperationError(null);
    setOperationMessage(null);
    try {
      const credential = await retryAdditionalSigner(
        session.signerKeypair,
        walletAddress,
        credentialId,
      );
      setOperationMessage(`Passkey registration confirmed as wallet signer #${credential.signerIndex}.`);
      await load();
    } catch (err) {
      setOperationError(errorMessage(err));
      await load();
    } finally {
      setRetryingCredentialId(null);
    }
  }, [load, retryAdditionalSigner, session, walletAddress]);

  const confirmRetryPasskey = useCallback((credentialId: string) => {
    Alert.alert(
      'Finish adding this passkey?',
      'This checks the existing wallet signer list and resumes this passkey registration if needed. It does not replace your current passkey, wallet address, or fee payer.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Continue', onPress: () => void retryPendingPasskey(credentialId) },
      ],
    );
  }, [retryPendingPasskey]);

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <FlowHeader title="Passkeys" />
      </View>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <Text style={styles.hint}>
          Passkeys listed on chain can authorise this wallet. A local credential is available to
          this installation; use your passkey provider&apos;s sync or sharing to make it available
          on another device.
        </Text>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Credentials on this device</Text>
          {thisDeviceKey ? (
            <View style={styles.signerRow}>
              <View style={styles.signerText}>
                <Text style={styles.signerTitle}>Primary passkey</Text>
                <Text style={styles.mono}>{shortKey(thisDeviceKey)}</Text>
              </View>
            </View>
          ) : (
            <Text style={styles.hint}>No primary passkey is available on this device.</Text>
          )}
          {additionalCredentials.map((credential) => (
            <View key={credential.credentialId} style={styles.signerRow}>
              <View style={styles.signerText}>
                <Text style={styles.signerTitle}>
                  Additional passkey
                  {credential.status === 'pending' ? ' · registration pending' : ''}
                </Text>
                <Text style={styles.mono}>{shortKey(credential.publicKey)}</Text>
              </View>
              {credential.status === 'pending' ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={retryingCredentialId !== null}
                  onPress={() => confirmRetryPasskey(credential.credentialId)}
                  style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
                >
                  {retryingCredentialId === credential.credentialId ? (
                    <ActivityIndicator color={colors.accent} />
                  ) : (
                    <Text style={styles.secondaryText}>Finish adding</Text>
                  )}
                </Pressable>
              ) : null}
            </View>
          ))}
          {additionalCredentials.length === 0 ? (
            <Text style={styles.hint}>No additional passkeys are saved on this device.</Text>
          ) : null}
        </View>

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
              const localCredential = additionalCredentials.find(
                (credential) => credential.publicKey.toLowerCase() === signer.publicKey.toLowerCase(),
              );
              return (
                <View key={signer.index} style={styles.signerRow}>
                  <View style={styles.signerText}>
                    <Text style={styles.signerTitle}>
                      {isThisDevice ? 'Primary passkey' : `Passkey #${signer.index}`}
                      {localCredential ? ' · saved on this device' : ''}
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

        {state.kind === 'ready' && thisDeviceKey ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: adding || retryingCredentialId !== null }}
            disabled={adding || retryingCredentialId !== null || additionalCredentials.some((credential) => credential.status === 'pending')}
            onPress={confirmAddPasskey}
            style={({ pressed }) => [styles.primary, pressed && styles.pressed, adding && styles.disabled]}
          >
            {adding ? <ActivityIndicator color={colors.onAccent} /> : null}
            <Text style={styles.primaryText}>{adding ? 'Adding passkey…' : 'Add a passkey'}</Text>
          </Pressable>
        ) : null}

        {operationMessage ? <Text style={styles.success}>{operationMessage}</Text> : null}
        {operationError ? <Text style={styles.error}>{operationError}</Text> : null}

        <Text style={styles.footnote}>
          Keep your existing passkey and recovery backup available. Adding a signer authorizes a
          new credential on chain; it does not transfer the fee payer or guarantee that the
          credential provider has synced the new passkey to another device.
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
    retry: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 8 },
    pressed: { opacity: 0.7 },
    primary: {
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      borderRadius: 100,
      backgroundColor: colors.accent,
    },
    primaryText: { fontFamily: fontFamily.bodySemiBold, fontSize: 15, color: colors.onAccent },
    disabled: { opacity: 0.6 },
    success: { fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19, color: colors.accent },
    error: { fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19, color: colors.danger },
    footnote: {
      fontFamily: fontFamily.body,
      fontSize: 12,
      lineHeight: 18,
      color: colors.textFaint,
    },
  });
