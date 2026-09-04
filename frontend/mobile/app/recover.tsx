import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Button, Card, Screen } from '../components/ui';
import {
  RECOVERY_TIMELOCK_SECONDS,
  createRecoverySigner,
  describeError,
  fetchWalletSigners,
  finalizeSignerRebind,
  getConfiguredRecoveryAddress,
  getPendingRecovery,
  isRecoveryUnlocked,
  isValidRecoveryAddress,
  isValidWalletAddress,
  listRecoveryServerUrls,
  requestSignerRebind,
  resolveRecoveryServers,
  walletHasSigner,
  clearPendingRecovery,
  type PendingRecovery,
  type RecoveryServer,
  type ResolvedRecoveryServers,
} from '../lib/recovery';
import { hexToUint8Array } from '../lib/webauthn';
import { colors } from '../theme/colors';
import { fontFamily, typography } from '../theme/typography';

/**
 * Recovery screen (`/recover`) — the way back in after losing the device that
 * held the wallet's passkey.
 *
 * The wallet has no seed phrase, so nothing on this new device can authorize a
 * signer change on its own. Instead the SEP-30 recovery servers registered while
 * the wallet was healthy co-sign the contract's `request_recovery`, a fresh
 * passkey is created here to be the new signer, and the contract's 7-day timelock
 * runs before `finalize_recovery` installs it. The wait is the safety property,
 * not an inconvenience: it is the window in which an owner who still holds their
 * key can cancel a recovery they did not start.
 *
 * Ported from the web wallet's `app/recover/page.tsx`, which recovers a *known*
 * passkey by matching it against the wallet's on-chain signers. That path needs
 * no servers but also cannot help a user whose passkey is gone with the device,
 * which is what this screen is for.
 */

type Stage = 'wallet' | 'servers' | 'signer' | 'pending' | 'done';

type ServerDraft = { baseUrl: string; authToken: string };

export default function RecoverScreen() {
  const router = useRouter();

  const [stage, setStage] = useState<Stage>('wallet');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [walletInput, setWalletInput] = useState('');
  const [signerCount, setSignerCount] = useState<number | null>(null);

  const [drafts, setDrafts] = useState<ServerDraft[]>([]);
  const [newServerUrl, setNewServerUrl] = useState('');
  const [resolved, setResolved] = useState<ResolvedRecoveryServers | null>(null);
  const [recoveryAddress, setRecoveryAddress] = useState(getConfiguredRecoveryAddress());

  const [pending, setPending] = useState<PendingRecovery | null>(null);
  const [finalizedHash, setFinalizedHash] = useState<string | null>(null);

  // A recovery started on a previous launch outlives the app: pick it back up
  // rather than making the user start again from the address.
  useEffect(() => {
    let active = true;
    (async () => {
      const [stored, urls] = await Promise.all([getPendingRecovery(), listRecoveryServerUrls()]);
      if (!active) return;
      setDrafts(urls.map((baseUrl) => ({ baseUrl, authToken: '' })));
      if (stored) {
        setPending(stored);
        setWalletInput(stored.walletAddress);
        setRecoveryAddress(stored.recoveryAddress);
        setStage('pending');
      }
    })().catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const run = useCallback(async (label: string, task: () => Promise<void>) => {
    setError(null);
    setNotice(null);
    setBusy(label);
    try {
      await task();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  }, []);

  // ── Step 1: the wallet ────────────────────────────────────────────────────

  function handleCheckWallet() {
    const walletAddress = walletInput.trim();
    if (!isValidWalletAddress(walletAddress)) {
      setError('Enter the wallet contract address. It starts with C.');
      return;
    }

    void run('Reading the wallet', async () => {
      const signers = await fetchWalletSigners(walletAddress);
      setSignerCount(signers.length);
      setStage('servers');
    });
  }

  // ── Step 2: the recovery servers ──────────────────────────────────────────

  function handleAddServer() {
    const baseUrl = newServerUrl.trim().replace(/\/+$/, '');
    if (!baseUrl.startsWith('https://')) {
      setError('A recovery server URL must start with https://');
      return;
    }
    if (drafts.some((draft) => draft.baseUrl === baseUrl)) {
      setNewServerUrl('');
      return;
    }
    setError(null);
    setDrafts((current) => [...current, { baseUrl, authToken: '' }]);
    setNewServerUrl('');
  }

  function handleResolveServers() {
    if (drafts.length === 0) {
      setError('Add at least one recovery server to continue.');
      return;
    }

    void run('Contacting recovery servers', async () => {
      const result = await resolveRecoveryServers(
        walletInput.trim(),
        drafts.map((draft) => ({
          baseUrl: draft.baseUrl,
          authToken: draft.authToken.trim() || undefined,
        }))
      );
      setResolved(result);

      if (result.servers.length === 0) {
        setError('No recovery server could vouch for this wallet. See the details below.');
        return;
      }
      // With one server the wallet's recovery key is that server's own signer;
      // with several it is the account they are all signers on, which the build
      // configures. Either way the user can correct it before anything is signed.
      if (!recoveryAddress) {
        setRecoveryAddress(result.servers[0]!.signerKey);
      }
    });
  }

  function handleContinue() {
    if (!isValidRecoveryAddress(recoveryAddress)) {
      setError("The wallet's recovery key must be a Stellar account address starting with G.");
      return;
    }
    setError(null);
    // A recovery already in flight must not start a second one — the contract
    // would reject it, and the passkey created for it would be orphaned.
    setStage(pending ? 'pending' : 'signer');
  }

  // ── Step 3: the new signer ────────────────────────────────────────────────

  function handleRequestRecovery() {
    const servers = resolved?.servers ?? [];
    if (servers.length === 0) {
      setError('No recovery server is available. Go back and check the servers again.');
      return;
    }

    void run('Creating the passkey', async () => {
      const signer = await createRecoverySigner(walletInput.trim());
      if (!signer) {
        setNotice('Passkey creation was dismissed. Nothing was submitted.');
        return;
      }

      setBusy('Requesting recovery');
      const started = await requestSignerRebind({
        walletAddress: walletInput.trim(),
        recoveryAddress: recoveryAddress.trim(),
        servers,
        signer,
      });
      setPending(started);
      setStage('pending');
    });
  }

  // ── Step 4: finalize ──────────────────────────────────────────────────────

  function handleFinalize() {
    if (!pending) return;

    const servers: RecoveryServer[] = resolved?.servers ?? [];
    if (servers.length === 0) {
      setError(
        'Re-authenticate with your recovery servers to finalize. Tap "Check servers" above.'
      );
      setStage('servers');
      return;
    }

    void run('Finalizing recovery', async () => {
      const result = await finalizeSignerRebind({ pending, servers });

      // The contract is the authority on whether the rotation took effect, so ask
      // it rather than inferring success from a submitted transaction.
      const bound = await walletHasSigner(
        pending.walletAddress,
        hexToUint8Array(pending.publicKeyHex)
      );
      if (!bound) {
        throw new Error(
          'The transaction succeeded but the wallet does not list the new signer yet. Wait a moment and check again.'
        );
      }

      setFinalizedHash(result.hash);
      setPending(null);
      setStage('done');
    });
  }

  function handleDiscardPending() {
    void run('Discarding', async () => {
      await clearPendingRecovery();
      setPending(null);
      setSignerCount(null);
      setResolved(null);
      setStage('wallet');
      setNotice('The pending recovery was removed from this device. It is still on-chain.');
    });
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[typography.heading, styles.title]}>Recover wallet</Text>
        <Text style={styles.subtitle}>
          Bind a new passkey to your wallet with help from your recovery servers.
        </Text>

        {stage === 'wallet' && (
          <Card style={styles.card}>
            <Text style={styles.label}>WALLET ADDRESS</Text>
            <TextInput
              style={styles.input}
              placeholder="C..."
              placeholderTextColor="rgba(246,247,248,0.3)"
              value={walletInput}
              onChangeText={(value) => {
                setWalletInput(value.trim());
                setError(null);
              }}
              autoCapitalize="characters"
              autoCorrect={false}
              spellCheck={false}
              editable={!busy}
            />
            <Text style={styles.hint}>
              Find this on another device where the wallet is open, or in a backup file. It starts
              with C.
            </Text>
            <Button
              label="Continue"
              onPress={handleCheckWallet}
              disabled={!!busy || walletInput.length === 0}
            />
          </Card>
        )}

        {stage === 'servers' && (
          <>
            <Card style={styles.card}>
              <Text style={styles.label}>WALLET</Text>
              <Text style={styles.address}>{walletInput}</Text>
              {signerCount !== null && (
                <Text style={styles.hint}>
                  {signerCount} signer{signerCount === 1 ? '' : 's'} registered on-chain today.
                </Text>
              )}
            </Card>

            <Card style={styles.card}>
              <Text style={styles.label}>RECOVERY SERVERS</Text>
              <Text style={styles.hint}>
                The servers you registered with while the wallet was healthy. Paste the session
                token each one issued after you re-authenticated your identity with it.
              </Text>

              {drafts.map((draft, index) => (
                <View key={draft.baseUrl} style={styles.serverRow}>
                  <Text style={styles.serverUrl}>{draft.baseUrl}</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="Session token (optional)"
                    placeholderTextColor="rgba(246,247,248,0.3)"
                    value={draft.authToken}
                    onChangeText={(value) =>
                      setDrafts((current) =>
                        current.map((item, i) =>
                          i === index ? { ...item, authToken: value } : item
                        )
                      )
                    }
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                    secureTextEntry
                    editable={!busy}
                  />
                </View>
              ))}

              <TextInput
                style={styles.input}
                placeholder="https://recovery.example.com"
                placeholderTextColor="rgba(246,247,248,0.3)"
                value={newServerUrl}
                onChangeText={setNewServerUrl}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                keyboardType="url"
                editable={!busy}
              />
              <Button
                label="Add server"
                variant="ghost"
                onPress={handleAddServer}
                disabled={!!busy || newServerUrl.trim().length === 0}
              />
              <Button
                label="Check servers"
                onPress={handleResolveServers}
                disabled={!!busy || drafts.length === 0}
              />
            </Card>

            {resolved && (
              <Card variant="md" style={styles.card}>
                <Text style={styles.label}>RESULT</Text>
                {resolved.servers.map((server) => (
                  <View key={server.baseUrl} style={styles.resultRow}>
                    <Text style={styles.resultOk}>Ready</Text>
                    <View style={styles.resultText}>
                      <Text style={styles.serverUrl}>{server.baseUrl}</Text>
                      <Text style={styles.address}>{server.signerKey}</Text>
                    </View>
                  </View>
                ))}
                {resolved.failures.map((failure) => (
                  <View key={failure.baseUrl} style={styles.resultRow}>
                    <Text style={styles.resultFailed}>Failed</Text>
                    <View style={styles.resultText}>
                      <Text style={styles.serverUrl}>{failure.baseUrl}</Text>
                      <Text style={styles.hint}>{failure.message}</Text>
                    </View>
                  </View>
                ))}
              </Card>
            )}

            {resolved && resolved.servers.length > 0 && (
              <Card style={styles.card}>
                <Text style={styles.label}>RECOVERY KEY</Text>
                <Text style={styles.hint}>
                  The address your wallet authorises to rotate its signer. The servers sign as this
                  account.
                </Text>
                <TextInput
                  style={styles.input}
                  placeholder="G..."
                  placeholderTextColor="rgba(246,247,248,0.3)"
                  value={recoveryAddress}
                  onChangeText={(value) => {
                    setRecoveryAddress(value.trim());
                    setError(null);
                  }}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  spellCheck={false}
                  editable={!busy}
                />
                <Button
                  label={pending ? 'Back to pending recovery' : 'Continue'}
                  onPress={handleContinue}
                  disabled={!!busy}
                />
              </Card>
            )}
          </>
        )}

        {stage === 'signer' && (
          <Card style={styles.card}>
            <Text style={styles.label}>NEW SIGNER</Text>
            <Text style={styles.body}>
              This device will create a new passkey and ask your recovery servers to bind it to the
              wallet. The wallet contract then waits{' '}
              {Math.round(RECOVERY_TIMELOCK_SECONDS / 86_400)} days before the new passkey can
              sign — time for you to cancel from a device that still has access, if this was not
              you.
            </Text>
            <Text style={styles.hint}>
              Nothing is stored on this device as your wallet credential until the wait is over and
              the contract confirms the change.
            </Text>
            <Button
              label="Create passkey and request recovery"
              onPress={handleRequestRecovery}
              disabled={!!busy}
            />
            <Button
              label="Back"
              variant="ghost"
              onPress={() => setStage('servers')}
              disabled={!!busy}
            />
          </Card>
        )}

        {stage === 'pending' && pending && (
          <>
            <Card style={styles.card}>
              <Text style={styles.label}>RECOVERY REQUESTED</Text>
              <Text style={styles.body}>
                Your recovery servers have asked the wallet to accept the new passkey. It can be
                finalized {formatUnlock(pending.unlockAt)}.
              </Text>
              <Text style={styles.hint}>Wallet</Text>
              <Text style={styles.address}>{pending.walletAddress}</Text>
              <Text style={styles.hint}>Request transaction</Text>
              <Text style={styles.address}>{pending.txHash}</Text>
              <Button
                label={isRecoveryUnlocked(pending) ? 'Finalize recovery' : 'Waiting for timelock'}
                onPress={handleFinalize}
                disabled={!!busy || !isRecoveryUnlocked(pending)}
              />
              <Button
                label="Check servers again"
                variant="ghost"
                onPress={() => setStage('servers')}
                disabled={!!busy}
              />
            </Card>

            <Pressable
              accessibilityRole="button"
              onPress={handleDiscardPending}
              disabled={!!busy}
              style={styles.discard}
            >
              <Text style={styles.discardText}>Forget this pending recovery</Text>
            </Pressable>
          </>
        )}

        {stage === 'done' && (
          <Card style={styles.card}>
            <Text style={styles.label}>WALLET RECOVERED</Text>
            <Text style={styles.body}>
              The new passkey on this device is now the wallet&apos;s signer. Your previous device
              can no longer sign for it.
            </Text>
            {finalizedHash && (
              <>
                <Text style={styles.hint}>Finalize transaction</Text>
                <Text style={styles.address}>{finalizedHash}</Text>
              </>
            )}
            <Button label="Open wallet" onPress={() => router.replace('/')} />
          </Card>
        )}

        {busy && (
          <View style={styles.busy}>
            <ActivityIndicator color={colors.gold} />
            <Text style={styles.hint}>{busy}…</Text>
          </View>
        )}

        {notice && <Text style={styles.notice}>{notice}</Text>}

        {error && (
          <Card variant="md" style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
          </Card>
        )}
      </ScrollView>
    </Screen>
  );
}

/** "on 5 August 2026" — the date the timelock expires, in the device's locale. */
function formatUnlock(unlockAt: number): string {
  const date = new Date(unlockAt * 1_000);
  return `on ${date.toLocaleDateString()} at ${date.toLocaleTimeString()}`;
}

const styles = StyleSheet.create({
  content: {
    gap: 16,
    paddingVertical: 24,
  },
  title: {
    color: colors.offWhite,
  },
  subtitle: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textMuted,
    marginTop: -8,
  },
  card: {
    padding: 16,
    gap: 12,
  },
  label: {
    fontFamily: fontFamily.accent,
    fontSize: 12,
    letterSpacing: 1,
    color: 'rgba(246,247,248,0.4)',
  },
  body: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 21,
    color: colors.offWhite,
  },
  hint: {
    fontFamily: fontFamily.body,
    fontSize: 12,
    lineHeight: 18,
    color: colors.textMuted,
  },
  address: {
    fontFamily: fontFamily.address,
    fontSize: 12,
    lineHeight: 18,
    color: colors.gold,
  },
  input: {
    fontFamily: fontFamily.address,
    fontSize: 13,
    color: colors.offWhite,
    backgroundColor: colors.surfaceMd,
    borderWidth: 1,
    borderColor: colors.borderDim,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  serverRow: {
    gap: 8,
  },
  serverUrl: {
    fontFamily: fontFamily.bodyMedium,
    fontSize: 13,
    color: colors.offWhite,
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  resultText: {
    flex: 1,
    gap: 2,
  },
  resultOk: {
    fontFamily: fontFamily.accent,
    fontSize: 11,
    letterSpacing: 1,
    color: colors.teal,
    marginTop: 2,
  },
  resultFailed: {
    fontFamily: fontFamily.accent,
    fontSize: 11,
    letterSpacing: 1,
    color: '#f87171',
    marginTop: 2,
  },
  busy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  notice: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textMuted,
  },
  errorCard: {
    padding: 16,
    borderColor: 'rgba(248,113,113,0.35)',
  },
  errorText: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 19,
    color: '#f87171',
  },
  discard: {
    alignSelf: 'center',
    paddingVertical: 8,
  },
  discardText: {
    fontFamily: fontFamily.bodyMedium,
    fontSize: 13,
    color: colors.textMuted,
  },
});
