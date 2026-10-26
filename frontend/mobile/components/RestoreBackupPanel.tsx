import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { BackupError, BackupTamperError } from '../lib/backup';
import {
  pickBackupFile,
  restoreFromFile,
  type PickedBackupFile,
  type RestoreResult,
} from '../lib/backupFile';
import {
  restoreBackupWithSignerCheck,
  type BackupRestoreResult,
} from '../lib/backupRestore';

export type RestorePanelResult = RestoreResult | BackupRestoreResult;

type Props = {
  /**
   * When `true` (default, used on the sign-in screen), the passkey on this
   * device must verify against the restored wallet's on-chain signer set —
   * the same check V191 introduces for address sign-in. A backup proves what
   * the wallet *was*, not that this device can sign for it, so a mismatch is
   * refused with a message naming the SEP-30 path and no wallet state is
   * written.
   *
   * Settings keeps `false` to preserve its existing read-only restore ("you
   * can view the wallet but not spend until you add this device's passkey"),
   * while still sharing this panel rather than copying it.
   */
  requireSignerMatch?: boolean;
  /** Called on success — the sign-in screen navigates to the dashboard here. */
  onRestored?: (result: RestorePanelResult) => void;
  testIDPrefix?: string;
};

type RestoreStatus = 'idle' | 'decrypting' | 'done';

/**
 * Shared restore-from-backup-file panel (V192 / #765).
 *
 * Exists once and is used by both Settings → Wallet backup and the sign-in
 * screen, so the two cannot drift into accepting and refusing different
 * cases. Reuses `pickBackupFile` / `readBackupFile` / `restoreFromFile`;
 * the sign-in path adds the V191 signer check before anything is persisted.
 */
export function RestoreBackupPanel({ requireSignerMatch = true, onRestored, testIDPrefix = 'restore' }: Props) {
  const { colors } = useTheme();
  const styles = createStyles(colors);

  const [file, setFile] = useState<PickedBackupFile | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [status, setStatus] = useState<RestoreStatus>('idle');
  const [result, setResult] = useState<RestorePanelResult | null>(null);
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

    // PBKDF2 blocks the JS thread — let the spinner paint first.
    await new Promise((resolve) => setTimeout(resolve, 0));

    try {
      const restored: RestorePanelResult = requireSignerMatch
        ? await restoreBackupWithSignerCheck(file, passphrase)
        : await restoreFromFile(file, passphrase);
      setResult(restored);
      setStatus('done');
      setPassphrase('');
      onRestored?.(restored);
    } catch (err) {
      setStatus('idle');
      // A failed authentication tag is the one error the user must not read as
      // "try again harder" — the file is either not theirs or not intact.
      const isTamper = err instanceof BackupTamperError;
      setTampered(isTamper);
      setError(describeError(err, 'Could not restore from that file.'));
    }
  }

  const restoredAddress =
    result && 'address' in result ? result.address : result?.metadata.address ?? null;
  const restoredSigners = result?.metadata.signers.length ?? 0;
  const restoredFilename = result?.filename ?? null;

  return (
    <View style={styles.wrap}>
      <Text style={styles.subtitle}>Import a backup file to restore your wallet on this device.</Text>

      <Pressable
        testID={`${testIDPrefix}-choose-file`}
        style={[styles.button, styles.buttonSecondary]}
        onPress={handlePick}
        disabled={status === 'decrypting'}
        accessibilityRole="button"
        accessibilityLabel="Choose backup file"
      >
        <Text style={styles.buttonLabel}>{file ? 'Choose a different file' : 'Choose file'}</Text>
      </Pressable>

      {file && <Text style={styles.filename}>{file.name}</Text>}

      <Text style={styles.label}>Backup passphrase</Text>
      <TextInput
        testID={`${testIDPrefix}-passphrase`}
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
        testID={`${testIDPrefix}-submit`}
        style={[styles.button, !canRestore && styles.buttonDisabled]}
        onPress={handleRestore}
        disabled={!canRestore}
        accessibilityRole="button"
        accessibilityLabel="Restore wallet from backup"
      >
        {status === 'decrypting' ? (
          <ActivityIndicator color="#f8fafc" />
        ) : (
          <Text style={styles.buttonLabel}>Restore wallet</Text>
        )}
      </Pressable>

      {status === 'decrypting' && (
        <Text style={styles.hint}>Checking the passphrase. This takes a few seconds.</Text>
      )}

      {status === 'done' && result && (
        <View style={styles.card} testID={`${testIDPrefix}-success`}>
          <Text style={styles.cardTitle}>Wallet restored</Text>
          {restoredAddress && <Text style={styles.address}>{restoredAddress}</Text>}
          <Text style={styles.cardBody}>
            {restoredSigners} signer{restoredSigners === 1 ? '' : 's'} restored
            {restoredFilename ? ` from ${restoredFilename}` : ''}.
          </Text>
          {requireSignerMatch ? (
            <Text style={styles.cardBody}>This device&apos;s passkey is a signer, so you are signed in.</Text>
          ) : (
            <Text style={styles.cardBody}>
              To sign transactions from this device, add its passkey as a signer on the wallet. Until
              then you can view the wallet but not spend from it.
            </Text>
          )}
        </View>
      )}

      {error && (
        <View style={tampered ? styles.errorCard : undefined} testID={`${testIDPrefix}-error`}>
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
    </View>
  );
}

function describeError(err: unknown, fallback: string): string {
  if (err instanceof BackupError || err instanceof Error) return err.message;
  return fallback;
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    wrap: { gap: 12 },
    subtitle: { color: colors.textSecondary, fontFamily: fontFamily.body, fontSize: 15, marginBottom: 4 },
    button: {
      backgroundColor: colors.accent,
      borderRadius: 10,
      paddingVertical: 14,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 8,
      minHeight: 48,
    },
    buttonSecondary: { backgroundColor: colors.surfaceMd, borderWidth: 1, borderColor: colors.border },
    buttonDisabled: { opacity: 0.5 },
    buttonLabel: { color: colors.textPrimary, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },
    filename: { color: colors.accentText, fontFamily: fontFamily.bodyMedium, fontSize: 13 },
    address: { color: colors.accentText, fontFamily: fontFamily.address, fontSize: 12 },
    label: { color: colors.textSecondary, fontFamily: fontFamily.bodySemiBold, fontSize: 13, marginTop: 8 },
    input: {
      backgroundColor: colors.surfaceMd,
      borderRadius: 10,
      padding: 14,
      color: colors.textPrimary,
      fontFamily: fontFamily.body,
      fontSize: 16,
      borderWidth: 1,
      borderColor: colors.border,
    },
    hint: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 12 },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 16,
      gap: 8,
    },
    cardTitle: { color: colors.textPrimary, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },
    cardBody: { color: colors.textSecondary, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },
    errorCard: {
      backgroundColor: colors.dangerSurface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.danger,
      padding: 16,
      gap: 8,
    },
    errorTitle: { color: colors.danger, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },
    error: { color: colors.danger, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },
  });
