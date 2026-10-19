/**
 * Reveal the secret key of a classic keypair wallet (#1041).
 *
 * For a phone that cannot make a passkey, the keypair wallet is the only
 * wallet available — and until now its secret could never leave the device.
 * The encrypted backup deliberately refuses private keys (that is correct for
 * a file destined for a cloud drive), so the keychain copy was the only copy,
 * and an uninstall destroyed the wallet silently. This screen gives the user a
 * way to take that copy off the phone, deliberately.
 *
 * The order of the screen is the design: identify the wallet → state the
 * consequences → force an acknowledgement → pass the device lock → show the
 * key. Nothing about the secret is rendered before the last step, and the key
 * is masked again as soon as the app is backgrounded or the screen loses
 * focus, so the next reveal has to go through the lock once more.
 *
 * The decision itself — whether this wallet HAS a secret that may be shown —
 * lives in `lib/secretExport.ts`, not here. A screen is a bad place for a
 * money-safety check: it is easy to render past it, and hard to test.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';

import { FlowHeader } from '../../components/FlowHeader';
import { useTheme } from '../../hooks/useTheme';
import type { ThemeColors } from '../../lib/theme';
import { fontFamily } from '../../theme/typography';
import { errorMessage } from '../../lib/errorMessage';
import {
  REFUSAL_COPY,
  requireDeviceUnlock,
  resolveSecretExport,
  type SecretExportState,
} from '../../lib/secretExport';

/** The states that may be shown but never show a key. */
type Refusal = Exclude<SecretExportState, { status: 'revealable' }>['status'];

/**
 * Where the screen is. `gate` is a keypair wallet waiting for the lock;
 * `revealed` is the only phase that holds a secret, and it is dropped as soon
 * as the app is backgrounded or the screen loses focus.
 */
type Phase =
  | { name: 'loading' }
  | { name: 'gate'; address: string }
  | { name: 'refusal'; reason: Refusal; address: string | null }
  | { name: 'revealed'; address: string; secret: string };

/** The prompt the device answers. Names what is behind it, not just "unlock". */
const UNLOCK_PROMPT = 'Unlock to reveal your wallet key';

export default function RevealSecretScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  const [acknowledged, setAcknowledged] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Read the wallet into a phase, keeping no key.
   *
   * `resolveSecretExport` returns the secret in the `revealable` state; it is
   * dropped here on purpose. The address alone decides what to render, and
   * until the user has passed the lock there is no reason for a key to sit in
   * component state where a stray render could reach it.
   */
  const inspect = useCallback(async () => {
    const state = await resolveSecretExport();
    if (state.status === 'revealable') {
      setPhase({ name: 'gate', address: state.address });
      return;
    }
    setPhase({
      name: 'refusal',
      reason: state.status,
      address: 'address' in state ? state.address : null,
    });
  }, []);

  useEffect(() => {
    void inspect().catch((err) => setError(errorMessage(err)));
  }, [inspect]);

  // Masking is not a courtesy — it is what makes the reveal one-time. Leaving
  // the screen or backgrounding the app destroys the displayed key, so showing
  // it again has to pass the device lock again.
  const conceal = useCallback(() => {
    setPhase((current) =>
      current.name === 'revealed' ? { name: 'gate', address: current.address } : current,
    );
    setAcknowledged(false);
  }, []);

  useFocusEffect(useCallback(() => conceal, [conceal]));

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') conceal();
    });
    return () => subscription.remove();
  }, [conceal]);

  /** Consequences → acknowledgement → device lock → the key. */
  async function handleReveal() {
    if (!acknowledged || busy || phase.name !== 'gate') return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const outcome = await requireDeviceUnlock({ promptMessage: UNLOCK_PROMPT });
      if (outcome !== 'unlocked') {
        if (outcome === 'cancelled') setNotice('Unlock cancelled. Nothing was revealed.');
        else if (outcome === 'not-protected') {
          setNotice(
            'This device has no passcode or biometric, so there is no lock to reveal behind. ' +
              'Set a device passcode in your phone’s settings first — otherwise anyone holding ' +
              'the phone would hold your money.',
          );
        } else setError('Unlock failed. Nothing was revealed.');
        return;
      }

      // Re-read after the lock, never before it: the wallet that exists when
      // the key is shown is the one that gets shown.
      const fresh = await resolveSecretExport();
      if (fresh.status === 'revealable') {
        setPhase({ name: 'revealed', address: fresh.address, secret: fresh.secret });
        return;
      }
      setNotice('This wallet changed while you were unlocking. Nothing was revealed.');
      setPhase(
        fresh.status === 'no-wallet'
          ? { name: 'refusal', reason: 'no-wallet', address: null }
          : { name: 'refusal', reason: fresh.status, address: fresh.address },
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy(secret: string) {
    try {
      await Clipboard.setStringAsync(secret);
      setNotice(
        'Copied. Your clipboard holds the key until something overwrites it — other apps can ' +
          'read it, and Veil cannot clear it. Paste it somewhere you trust, then copy something ' +
          'harmless.',
      );
    } catch {
      setNotice('Copying is not available here. Write the key down instead.');
    }
  }

  // ── Panels ────────────────────────────────────────────────────────────────────

  if (phase.name === 'loading') {
    return (
      <SafeAreaView style={styles.screen} edges={['top']} testID="reveal-secret-screen">
        <View style={styles.header}>
          <FlowHeader title="Reveal secret key" />
        </View>
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      </SafeAreaView>
    );
  }

  // A wallet this screen cannot export — a smart wallet above all — is told why
  // in the same shape as any other refusal: an explanation, not a dead end.
  if (phase.name === 'refusal') {
    const refusal = REFUSAL_COPY[phase.reason];
    return (
      <SafeAreaView style={styles.screen} edges={['top']} testID="reveal-secret-screen">
        <View style={styles.header}>
          <FlowHeader title="Reveal secret key" />
        </View>
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          testID="reveal-secret-scroll"
        >
          <View style={styles.card} testID="secret-export-refusal">
            <Text style={styles.cardTitle}>{refusal.title}</Text>
            <Text style={styles.cardBody}>{refusal.body}</Text>
            {phase.address && (
              <Text style={styles.address} selectable accessibilityLabel={`Wallet address ${phase.address}`}>
                {phase.address}
              </Text>
            )}
            {phase.reason === 'smart-wallet' && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Create an encrypted backup"
                testID="secret-refusal-backup-link"
                onPress={() => router.push('/settings/backup')}
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
              >
                <Text style={styles.secondaryLabel}>Create an encrypted backup</Text>
              </Pressable>
            )}
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (phase.name === 'gate') {
    return (
      <SafeAreaView style={styles.screen} edges={['top']} testID="reveal-secret-screen">
        <View style={styles.header}>
          <FlowHeader title="Reveal secret key" />
        </View>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          testID="reveal-secret-scroll"
        >
          {/* Identify the wallet before anything about its key. */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Wallet address</Text>
            <Text
              style={styles.address}
              selectable
              testID="gate-address"
              accessibilityLabel={`Wallet address ${phase.address}`}
            >
              {phase.address}
            </Text>
            <Text style={styles.cardBody}>
              This is a classic keypair wallet, so its signing key lives on this device. The
              address above is the one that key belongs to — take both together.
            </Text>
          </View>

          {/* The consequences, stated before the secret is reachable. */}
          <View style={[styles.card, styles.warningCard]} testID="secret-export-consequences">
            <Text style={styles.warningTitle}>Read this before you reveal it</Text>
            <Text style={styles.cardBody}>
              • Anyone who has this secret can move everything in this wallet, from any device,
              with no app and no login. Holding the key is holding the money.
            </Text>
            <Text style={styles.cardBody}>
              • This is the only copy. It exists in this phone’s keychain and nowhere else —
              break, lose or uninstall this app and the wallet is gone.
            </Text>
            <Text style={styles.cardBody}>
              • Veil cannot recover it. There is nothing to verify against and no one to call.
            </Text>

            <Text style={styles.cardBody}>
              Do not screenshot it, do not send it in a chat, do not paste it into a website.
              Write it down on paper, or copy it into something only you can open.
            </Text>

            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: acknowledged }}
              accessibilityLabel="I understand anyone with this secret can spend this wallet, and Veil cannot recover it"
              testID="secret-reveal-ack"
              onPress={() => setAcknowledged((value) => !value)}
              style={styles.checkboxRow}
            >
              <View style={[styles.checkbox, acknowledged && styles.checkboxChecked]}>
                {acknowledged && <Text style={styles.checkboxTick}>✓</Text>}
              </View>
              <Text style={styles.checkboxLabel}>
                I understand that anyone with this secret can spend this wallet, that this is the
                only copy, and that Veil cannot recover it.
              </Text>
            </Pressable>

            {error && <Text style={styles.error}>{error}</Text>}
            {notice && <Text style={styles.notice}>{notice}</Text>}

            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !acknowledged || busy }}
              accessibilityLabel="Unlock and reveal the secret key"
              testID="secret-reveal-button"
              disabled={!acknowledged || busy}
              onPress={handleReveal}
              style={({ pressed }) => [
                styles.primaryButton,
                (!acknowledged || busy) && styles.primaryButtonDisabled,
                pressed && acknowledged && !busy && styles.pressed,
              ]}
            >
              {busy ? (
                <ActivityIndicator color={colors.textStrong} />
              ) : (
                <Text style={styles.primaryLabel}>Unlock and reveal</Text>
              )}
            </Pressable>
            <Text style={styles.footnote}>
              Every reveal asks your device for its passcode or biometric. The key is hidden
              again as soon as you leave this screen or switch apps.
            </Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── Revealed ──────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.screen} edges={['top']} testID="reveal-secret-screen">
      <View style={styles.header}>
        <FlowHeader title="Secret key" />
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        testID="reveal-secret-scroll"
      >
        <View style={[styles.card, styles.onlyCopyCard]} testID="secret-only-copy-banner">
          <Text style={styles.warningTitle}>This is the only copy</Text>
          <Text style={styles.cardBody}>
            Take it now. Once you leave this screen it is hidden again, and revealing it asks for
            your device lock from the start. Anyone who gets these bytes gets the wallet.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Wallet address</Text>
          <Text
            style={styles.address}
            selectable
            testID="secret-revealed-address"
            accessibilityLabel={`Wallet address ${phase.address}`}
          >
            {phase.address}
          </Text>

          <Text style={styles.cardTitle}>Secret key</Text>
          <Text
            style={styles.secret}
            selectable
            testID="secret-revealed-value"
            accessibilityLabel="Secret key — anyone with this can spend the wallet"
          >
            {phase.secret}
          </Text>
        </View>

        {notice && <Text style={styles.notice}>{notice}</Text>}

        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copy the secret key"
            testID="secret-copy-button"
            onPress={() => handleCopy(phase.secret)}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryLabel}>Copy secret key</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Hide the secret key"
            testID="secret-hide-button"
            onPress={conceal}
            style={({ pressed }) => [styles.ghostButton, pressed && styles.pressed]}
          >
            <Text style={styles.ghostLabel}>Hide it</Text>
          </Pressable>
        </View>

        <Text style={styles.footnote}>
          To use this on another phone: install Veil there and import the wallet with this key.
          Importing derives the same address — if it does not, that is the wrong key.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: {
      backgroundColor: colors.background,
      flex: 1,
    },
    header: {
      paddingHorizontal: 20,
      paddingTop: 16,
    },
    center: {
      alignItems: 'center',
      flex: 1,
      justifyContent: 'center',
    },
    content: {
      gap: 16,
      padding: 24,
      paddingBottom: 48,
    },
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 16,
      borderWidth: 1,
      gap: 10,
      padding: 16,
    },
    warningCard: {
      backgroundColor: colors.dangerSurface,
      borderColor: colors.danger,
    },
    /** Same weight as the warning, different meaning: act now, carefully. */
    onlyCopyCard: {
      borderColor: colors.accent,
    },
    cardTitle: {
      color: colors.textStrong,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
    },
    cardBody: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 20,
    },
    warningTitle: {
      color: colors.danger,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
    },
    /** Full, never elided — a truncated address is worse than none at all. */
    address: {
      color: colors.accentText,
      fontFamily: fontFamily.address,
      fontSize: 13,
      lineHeight: 20,
    },
    secret: {
      color: colors.textStrong,
      fontFamily: fontFamily.address,
      fontSize: 16,
      lineHeight: 24,
    },
    checkboxRow: {
      alignItems: 'flex-start',
      flexDirection: 'row',
      gap: 12,
      marginTop: 4,
    },
    checkbox: {
      alignItems: 'center',
      borderColor: colors.border,
      borderRadius: 6,
      borderWidth: 1,
      height: 22,
      justifyContent: 'center',
      marginTop: 1,
      width: 22,
    },
    checkboxChecked: {
      backgroundColor: colors.danger,
      borderColor: colors.danger,
    },
    checkboxTick: {
      color: colors.textStrong,
      fontSize: 14,
      fontWeight: '700',
    },
    checkboxLabel: {
      color: colors.textPrimary,
      flex: 1,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
    },
    primaryButton: {
      alignItems: 'center',
      backgroundColor: colors.accent,
      borderRadius: 12,
      justifyContent: 'center',
      minHeight: 52,
      paddingVertical: 14,
    },
    primaryButtonDisabled: {
      opacity: 0.4,
    },
    primaryLabel: {
      color: colors.onAccent,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 16,
    },
    secondaryButton: {
      alignItems: 'center',
      borderColor: colors.accent,
      borderRadius: 10,
      borderWidth: 1,
      flex: 1,
      justifyContent: 'center',
      minHeight: 48,
      paddingVertical: 14,
    },
    secondaryLabel: {
      color: colors.accentText,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
    },
    ghostButton: {
      alignItems: 'center',
      borderColor: colors.border,
      borderRadius: 10,
      borderWidth: 1,
      flex: 1,
      justifyContent: 'center',
      minHeight: 48,
      paddingVertical: 14,
    },
    ghostLabel: {
      color: colors.textSecondary,
      fontFamily: fontFamily.bodyMedium,
      fontSize: 15,
    },
    actions: {
      flexDirection: 'row',
      gap: 12,
    },
    error: {
      color: colors.danger,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
    },
    notice: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
    },
    footnote: {
      color: colors.textFaint,
      fontFamily: fontFamily.body,
      fontSize: 12,
      lineHeight: 18,
    },
    pressed: {
      opacity: 0.7,
    },
  });
