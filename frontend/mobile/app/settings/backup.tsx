import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

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

/**
 * Anything shorter is not worth the 210k PBKDF2 rounds standing behind it. The
 * backup file is expected to end up somewhere the user does not fully control
 * (a cloud drive, a messaging app), so the passphrase is the only thing keeping
 * it shut.
 */
const MIN_PASSPHRASE_LENGTH = 12;

type Mode = 'export' | 'restore';

export default function BackupScreen() {
  const [mode, setMode] = useState<Mode>('export');

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Wallet backup</Text>

      <View style={styles.segmented}>
        <SegmentButton label="Back up" active={mode === 'export'} onPress={() => setMode('export')} />
        <SegmentButton
          label="Restore"
          active={mode === 'restore'}
          onPress={() => setMode('restore')}
        />
      </View>

      {mode === 'export' ? <ExportPanel /> : <RestorePanel />}
    </ScrollView>
  );
}

// ── Export ───────────────────────────────────────────────────────────────────────

type ExportStatus = 'idle' | 'encrypting' | 'done';

function ExportPanel() {
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
      <Text style={styles.subtitle}>
        Export an encrypted copy of your wallet so you can restore it on another device.
      </Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>What goes in the file</Text>
        <Text style={styles.cardBody}>
          Your wallet address, your registered signer public keys, and your app settings — all
          sealed with AES-256-GCM. Private keys never leave your passkey, so they are not in the
          backup and cannot be.
        </Text>
      </View>

      <Text style={styles.label}>Backup passphrase</Text>
      <TextInput
        style={styles.input}
        placeholder={`At least ${MIN_PASSPHRASE_LENGTH} characters`}
        placeholderTextColor="#64748b"
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
        placeholderTextColor="#64748b"
        value={confirmation}
        onChangeText={setConfirmation}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        editable={status !== 'encrypting'}
      />
      {mismatched && <Text style={styles.hint}>Passphrases do not match.</Text>}

      <Text style={styles.warning}>
        There is no way to recover this passphrase. Lose it and the backup is unreadable, by us and
        by anyone else.
      </Text>

      <Pressable
        style={[styles.button, !canExport && styles.buttonDisabled]}
        onPress={handleExport}
        disabled={!canExport}
        accessibilityRole="button"
        accessibilityLabel="Create encrypted backup"
      >
        {status === 'encrypting' ? (
          <ActivityIndicator color="#f8fafc" />
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
            style={[styles.button, styles.buttonSecondary]}
            onPress={() => offerShare(result)}
            accessibilityRole="button"
            accessibilityLabel="Share backup file"
          >
            <Text style={styles.buttonLabel}>Share</Text>
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

function RestorePanel() {
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
        Import a backup file to restore your wallet on this device.
      </Text>

      <Pressable
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
        style={styles.input}
        placeholder="The passphrase you sealed it with"
        placeholderTextColor="#64748b"
        value={passphrase}
        onChangeText={setPassphrase}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        editable={status !== 'decrypting'}
      />

      <Pressable
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
}: {
  label: string;
  active: boolean;
  onPress: () => void;
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

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: '#0B0B0F',
    padding: 24,
    gap: 12,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    color: '#9BA1A6',
    fontSize: 15,
    marginBottom: 4,
  },
  segmented: {
    flexDirection: 'row',
    backgroundColor: '#11131a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    padding: 4,
    gap: 4,
  },
  segment: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 7,
    alignItems: 'center',
  },
  segmentActive: {
    backgroundColor: '#334155',
  },
  segmentLabel: {
    color: '#94a3b8',
    fontSize: 14,
    fontWeight: '600',
  },
  segmentLabelActive: {
    color: '#f8fafc',
  },
  card: {
    backgroundColor: '#11131a',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#334155',
    padding: 16,
    gap: 8,
  },
  cardTitle: {
    color: '#f1f5f9',
    fontSize: 15,
    fontWeight: '600',
  },
  cardBody: {
    color: '#9BA1A6',
    fontSize: 13,
    lineHeight: 19,
  },
  filename: {
    color: '#6366f1',
    fontSize: 13,
    fontWeight: '600',
  },
  address: {
    color: '#6366f1',
    fontSize: 12,
    fontWeight: '600',
  },
  label: {
    color: '#cbd5e1',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 8,
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
  hint: {
    color: '#94a3b8',
    fontSize: 12,
  },
  warning: {
    color: '#fbbf24',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 8,
  },
  button: {
    backgroundColor: '#6366f1',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
    minHeight: 48,
  },
  buttonSecondary: {
    backgroundColor: '#334155',
  },
  buttonDisabled: {
    backgroundColor: '#312e81',
    opacity: 0.5,
  },
  buttonLabel: {
    color: '#f8fafc',
    fontSize: 15,
    fontWeight: '600',
  },
  notice: {
    color: '#94a3b8',
    fontSize: 13,
    lineHeight: 19,
  },
  errorCard: {
    backgroundColor: '#1f1113',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#7f1d1d',
    padding: 16,
    gap: 8,
  },
  errorTitle: {
    color: '#fca5a5',
    fontSize: 15,
    fontWeight: '600',
  },
  error: {
    color: '#f87171',
    fontSize: 13,
    lineHeight: 19,
  },
});
