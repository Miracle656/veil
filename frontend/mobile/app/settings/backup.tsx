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

import { BackupError } from '../../lib/backup';
import { exportBackupToFile, shareBackupFile, type BackupExport } from '../../lib/backupFile';

/**
 * Anything shorter is not worth the 210k PBKDF2 rounds standing behind it. The
 * backup file is expected to end up somewhere the user does not fully control
 * (a cloud drive, a messaging app), so the passphrase is the only thing keeping
 * it shut.
 */
const MIN_PASSPHRASE_LENGTH = 12;

type Status = 'idle' | 'encrypting' | 'done';

export default function BackupScreen() {
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [status, setStatus] = useState<Status>('idle');
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
      setError(
        err instanceof BackupError || err instanceof Error
          ? err.message
          : 'Could not create a backup.'
      );
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
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Back up wallet</Text>
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
    </ScrollView>
  );
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
  error: {
    color: '#f87171',
    fontSize: 13,
    lineHeight: 19,
  },
});
