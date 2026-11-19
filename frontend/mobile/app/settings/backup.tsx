/**
 * Wallet backup — export and restore the encrypted envelope.
 *
 * Previously this screen drew itself from a hardcoded slate-and-indigo palette
 * with system font weights, so it read as a different app sitting inside Veil:
 * no back chevron, no Lora title, none of the theme's colours, and nothing that
 * survived a light/dark switch. Everything visual here now comes from the theme
 * and the brand typefaces, like every other settings screen.
 *
 * The copy changed for the same reason the colours did. "Encrypted backup" says
 * what the file is, not what it is for or when it matters, and the one fact a
 * user has to know before trusting it — that this restores the wallet's
 * identity, not the ability to spend, because the private key never leaves the
 * passkey — was buried in a card that only appeared after a successful restore.
 * It is stated up front now.
 */

import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FlowHeader } from '../../components/FlowHeader';
import { useTheme } from '../../hooks/useTheme';
import { BackupError, BackupTamperError } from '../../lib/backup';
import {
  exportBackupToFile,
  pickBackupFile,
  restoreFromFile,
  shareBackupFile,
  type BackupExport,
  type PickedBackupFile,
  type RestoreResult,
} from '../../lib/backupFile';
import type { ThemeColors } from '../../lib/theme';
import { fontFamily } from '../../theme/typography';

/**
 * Anything shorter is not worth the 210k PBKDF2 rounds standing behind it. The
 * backup file is expected to end up somewhere the user does not fully control
 * (a cloud drive, a messaging app), so the passphrase is the only thing keeping
 * it shut.
 */
const MIN_PASSPHRASE_LENGTH = 12;

type Mode = 'export' | 'restore';
type Styles = ReturnType<typeof createStyles>;

export default function BackupScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [mode, setMode] = useState<Mode>('export');

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <FlowHeader title="Wallet backup" />
      </View>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.intro}>
          A backup is a single encrypted file that lets you bring this wallet back on a new phone.
          Keep one anywhere you will still reach if this device is lost.
        </Text>

        <View style={styles.segmented}>
          <SegmentButton
            label="Back up"
            active={mode === 'export'}
            onPress={() => setMode('export')}
            styles={styles}
          />
          <SegmentButton
            label="Restore"
            active={mode === 'restore'}
            onPress={() => setMode('restore')}
            styles={styles}
          />
        </View>

        {mode === 'export' ? (
          <ExportPanel styles={styles} colors={colors} />
        ) : (
          <RestorePanel styles={styles} colors={colors} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Export ───────────────────────────────────────────────────────────────────────

type ExportStatus = 'idle' | 'encrypting' | 'done';

function ExportPanel({ styles, colors }: { styles: Styles; colors: ThemeColors }) {
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [status, setStatus] = useState<ExportStatus>('idle');
  const [result, setResult] = useState<BackupExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const tooShort = passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE_LENGTH;
  const mismatched = confirmation.length > 0 && confirmation !== passphrase;
  const canExport =
    status !== 'encrypting'
    && passphrase.length >= MIN_PASSPHRASE_LENGTH
    && confirmation === passphrase;

  async function handleExport() {
    if (!canExport) return;
    setError(null);
    setNotice(null);
    setResult(null);
    setStatus('encrypting');

    // PBKDF2 runs synchronously on the JS thread. Yield once so the state change
    // above is committed and the spinner is on screen before it starts.
    await new Promise((resolve) => setTimeout(resolve, 0));

    try {
      const exported = await exportBackupToFile(passphrase);
      setResult(exported);
      setStatus('done');
      // The passphrase is not needed again, and holding it in component state
      // for the rest of the session serves no purpose.
      setPassphrase('');
      setConfirmation('');
      await offerShare(exported);
    } catch (err) {
      setStatus('idle');
      setError(describeError(err, 'Could not create a backup.'));
    }
  }

  async function offerShare(exported: BackupExport) {
    try {
      const shared = await shareBackupFile(exported.uri, exported.filename);
      if (!shared) {
        setNotice(`Sharing is unavailable here. The file is saved at ${exported.uri}`);
      }
    } catch {
      setNotice('Sharing was dismissed. Tap Share again to save the file.');
    }
  }

  return (
    <>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>What goes in the file</Text>
        <Text style={styles.cardBody}>
          Your wallet address, your registered signer public keys, and your app settings — all
          sealed with AES-256-GCM.
        </Text>
        <Text style={styles.cardBody}>
          Your private key never leaves your passkey, so it is not in the backup and cannot be. That
          means the file is useless to anyone who takes it, and that restoring it brings the wallet
          back to view — your passkey is still what spends from it.
        </Text>
      </View>

      <Text style={styles.label}>Backup passphrase</Text>
      <TextInput
        style={styles.input}
        placeholder={`At least ${MIN_PASSPHRASE_LENGTH} characters`}
        placeholderTextColor={colors.textFaint}
        value={passphrase}
        onChangeText={setPassphrase}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        editable={status !== 'encrypting'}
      />
      {tooShort && (
        <Text style={styles.hint}>Use at least {MIN_PASSPHRASE_LENGTH} characters.</Text>
      )}

      <Text style={styles.label}>Confirm passphrase</Text>
      <TextInput
        style={styles.input}
        placeholder="Type it again"
        placeholderTextColor={colors.textFaint}
        value={confirmation}
        onChangeText={setConfirmation}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        editable={status !== 'encrypting'}
      />
      {mismatched && <Text style={styles.hint}>Passphrases do not match.</Text>}

      <View style={styles.warningCard}>
        <Text style={styles.warning}>
          There is no way to recover this passphrase. Lose it and the backup is unreadable, by us
          and by anyone else.
        </Text>
      </View>

      <Pressable
        style={({ pressed }) => [
          styles.button,
          !canExport && styles.buttonDisabled,
          pressed && canExport && styles.pressed,
        ]}
        onPress={handleExport}
        disabled={!canExport}
        accessibilityRole="button"
        accessibilityLabel="Create encrypted backup"
      >
        {status === 'encrypting' ? (
          <ActivityIndicator color={colors.onAccent} />
        ) : (
          <Text style={styles.buttonLabel}>Create encrypted backup</Text>
        )}
      </Pressable>

      {status === 'encrypting' && (
        <Text style={styles.hint}>Deriving the encryption key. This takes a few seconds.</Text>
      )}

      {status === 'done' && result && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Backup ready</Text>
          <Text style={styles.filename}>{result.filename}</Text>
          <Text style={styles.cardBody}>
            Save it somewhere you will still have access to if this device is lost.
          </Text>
          <Pressable
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
            onPress={() => offerShare(result)}
            accessibilityRole="button"
            accessibilityLabel="Share backup file"
          >
            <Text style={styles.secondaryLabel}>Share</Text>
          </Pressable>
        </View>
      )}

      {notice && <Text style={styles.notice}>{notice}</Text>}
      {error && <Text style={styles.error}>{error}</Text>}
    </>
  );
}

// ── Restore ──────────────────────────────────────────────────────────────────────

type RestoreStatus = 'idle' | 'decrypting' | 'done';

function RestorePanel({ styles, colors }: { styles: Styles; colors: ThemeColors }) {
  const [file, setFile] = useState<PickedBackupFile | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [status, setStatus] = useState<RestoreStatus>('idle');
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tampered, setTampered] = useState(false);

  const canRestore = status !== 'decrypting' && !!file && passphrase.length > 0;

  async function handlePick() {
    setError(null);
    setTampered(false);
    setResult(null);
    setStatus('idle');
    try {
      const picked = await pickBackupFile();
      if (picked) setFile(picked);
    } catch {
      setError('Could not open the file picker.');
    }
  }

  async function handleRestore() {
    if (!canRestore || !file) return;
    setError(null);
    setTampered(false);
    setStatus('decrypting');

    // As on export, PBKDF2 blocks the JS thread — let the spinner paint first.
    await new Promise((resolve) => setTimeout(resolve, 0));

    try {
      const restored = await restoreFromFile(file, passphrase);
      setResult(restored);
      setStatus('done');
      setPassphrase('');
    } catch (err) {
      setStatus('idle');
      // A failed authentication tag is the one error the user must not read as
      // "try again harder" — the file is either not theirs or not intact.
      setTampered(err instanceof BackupTamperError);
      setError(describeError(err, 'Could not restore from that file.'));
    }
  }

  return (
    <>
      <Text style={styles.subtitle}>
        Pick a backup file and unlock it with the passphrase you sealed it with.
      </Text>

      <Pressable
        style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
        onPress={handlePick}
        disabled={status === 'decrypting'}
        accessibilityRole="button"
        accessibilityLabel="Choose backup file"
      >
        <Text style={styles.secondaryLabel}>
          {file ? 'Choose a different file' : 'Choose file'}
        </Text>
      </Pressable>

      {file && <Text style={styles.filename}>{file.name}</Text>}

      <Text style={styles.label}>Backup passphrase</Text>
      <TextInput
        style={styles.input}
        placeholder="The passphrase you sealed it with"
        placeholderTextColor={colors.textFaint}
        value={passphrase}
        onChangeText={setPassphrase}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        editable={status !== 'decrypting'}
      />

      <Pressable
        style={({ pressed }) => [
          styles.button,
          !canRestore && styles.buttonDisabled,
          pressed && canRestore && styles.pressed,
        ]}
        onPress={handleRestore}
        disabled={!canRestore}
        accessibilityRole="button"
        accessibilityLabel="Restore wallet from backup"
      >
        {status === 'decrypting' ? (
          <ActivityIndicator color={colors.onAccent} />
        ) : (
          <Text style={styles.buttonLabel}>Restore wallet</Text>
        )}
      </Pressable>

      {status === 'decrypting' && (
        <Text style={styles.hint}>Checking the passphrase. This takes a few seconds.</Text>
      )}

      {status === 'done' && result && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Wallet restored</Text>
          <Text style={styles.address}>{result.metadata.address}</Text>
          <Text style={styles.cardBody}>
            {result.metadata.signers.length} signer
            {result.metadata.signers.length === 1 ? '' : 's'} restored from {result.filename}.
          </Text>
          <Text style={styles.cardBody}>
            To sign transactions from this device, add its passkey as a signer on the wallet. Until
            then you can view the wallet but not spend from it.
          </Text>
        </View>
      )}

      {error && (
        <View style={tampered ? styles.errorCard : undefined}>
          {tampered && <Text style={styles.errorTitle}>This backup did not verify</Text>}
          <Text style={styles.error}>{error}</Text>
          {tampered && (
            <Text style={styles.cardBody}>
              Either the passphrase is wrong or the file has been altered since it was created.
              Nothing on this device was changed.
            </Text>
          )}
        </View>
      )}
    </>
  );
}

// ── Shared ───────────────────────────────────────────────────────────────────────

function SegmentButton({
  label,
  active,
  onPress,
  styles,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  styles: Styles;
}) {
  return (
    <Pressable
      style={[styles.segment, active && styles.segmentActive]}
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.segmentLabel, active && styles.segmentLabelActive]}>{label}</Text>
    </Pressable>
  );
}

function describeError(err: unknown, fallback: string): string {
  if (err instanceof BackupError || err instanceof Error) return err.message;
  return fallback;
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    header: { paddingHorizontal: 20, paddingTop: 16 },
    container: { padding: 20, paddingBottom: 48, gap: 12 },
    intro: {
      fontFamily: fontFamily.body,
      fontSize: 14,
      lineHeight: 21,
      color: colors.textSecondary,
    },
    subtitle: {
      fontFamily: fontFamily.body,
      fontSize: 14,
      lineHeight: 21,
      color: colors.textSecondary,
      marginBottom: 4,
    },
    segmented: {
      flexDirection: 'row',
      backgroundColor: colors.surfaceMd,
      borderRadius: 100,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      padding: 4,
      gap: 4,
      marginBottom: 4,
    },
    segment: { flex: 1, paddingVertical: 10, borderRadius: 100, alignItems: 'center' },
    segmentActive: { backgroundColor: colors.accent },
    segmentLabel: {
      fontFamily: fontFamily.bodyMedium,
      fontSize: 14,
      color: colors.textMuted,
    },
    segmentLabelActive: { fontFamily: fontFamily.bodySemiBold, color: colors.onAccent },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      padding: 18,
      gap: 10,
    },
    cardTitle: {
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 16,
      color: colors.textStrong,
    },
    cardBody: {
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
      color: colors.textMuted,
    },
    filename: {
      fontFamily: fontFamily.address,
      fontSize: 13,
      color: colors.accentText,
    },
    address: {
      fontFamily: fontFamily.address,
      fontSize: 12,
      color: colors.accentText,
    },
    label: {
      fontFamily: fontFamily.bodyMedium,
      fontSize: 13,
      color: colors.textSecondary,
      marginTop: 8,
    },
    input: {
      backgroundColor: colors.surfaceMd,
      borderRadius: 14,
      padding: 14,
      fontFamily: fontFamily.body,
      color: colors.textPrimary,
      fontSize: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderStrong,
    },
    hint: { fontFamily: fontFamily.body, fontSize: 12, lineHeight: 18, color: colors.textMuted },
    warningCard: {
      backgroundColor: colors.surface,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.accent,
      padding: 14,
      marginTop: 8,
    },
    warning: {
      fontFamily: fontFamily.body,
      fontSize: 12,
      lineHeight: 18,
      color: colors.accentText,
    },
    button: {
      backgroundColor: colors.accent,
      borderRadius: 100,
      paddingVertical: 15,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 8,
      minHeight: 50,
    },
    buttonDisabled: { backgroundColor: colors.surfaceMd },
    buttonLabel: {
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
      color: colors.onAccent,
    },
    secondary: {
      alignItems: 'center',
      paddingVertical: 12,
      borderRadius: 100,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      marginTop: 8,
    },
    secondaryLabel: {
      fontFamily: fontFamily.bodyMedium,
      fontSize: 14,
      color: colors.textPrimary,
    },
    pressed: { opacity: 0.7 },
    notice: { fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19, color: colors.textMuted },
    errorCard: {
      backgroundColor: colors.dangerSurface,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.danger,
      padding: 16,
      gap: 8,
    },
    errorTitle: {
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
      color: colors.danger,
    },
    error: { fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19, color: colors.danger },
  });
