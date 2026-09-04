/**
 * Device-side wiring for encrypted wallet backups.
 *
 * `lib/backup.ts` owns the format and the crypto; this module owns everything
 * that touches the device — reading the wallet's non-secret state out of
 * AsyncStorage, writing the sealed envelope to a file and handing it to the
 * system share sheet, and on the way back in, picking a file the user chooses
 * and writing the decrypted state to storage.
 *
 * The storage keys mirror the ones the web wallet writes to `localStorage`, so a
 * backup exported from either client describes the same wallet.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import {
  BackupError,
  bindNewSigner,
  createBackup,
  decryptBackup,
  deserializeBackup,
  type BackupSecret,
  type BackupStorageBackend,
  type EncryptedBackup,
  type WalletBackupMetadata,
} from './backup';

// Wallet credential keys written by the SDK (`useInvisibleWallet`).
const ADDRESS_KEY = 'invisible_wallet_address';
const PUBLIC_KEY_KEY = 'invisible_wallet_public_key';
const SETTINGS_KEY = 'veil_wallet_settings';

const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

/** Sub-directory of the cache dir that exported envelopes are staged in. */
const EXPORT_DIR_NAME = 'veil-backups';

/** Extension used for exported envelopes. */
export const BACKUP_FILE_EXTENSION = '.veilbackup.json';

// ── Wallet state -> metadata ─────────────────────────────────────────────────────

async function readSettings(): Promise<Record<string, unknown> | undefined> {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Corrupt settings must not block a backup of the wallet identity itself.
    return undefined;
  }
}

/**
 * Read this device's non-secret wallet state into a backup metadata object.
 *
 * @param overrides Extra fields (e.g. the full on-chain signer set, or the
 *                  factory/network the wallet lives on) merged into the result.
 * @throws {BackupError} if no wallet is registered on this device.
 */
export async function collectWalletMetadata(
  overrides: Partial<WalletBackupMetadata> = {}
): Promise<WalletBackupMetadata> {
  const address = overrides.address ?? (await AsyncStorage.getItem(ADDRESS_KEY)) ?? '';
  if (!address) {
    throw new BackupError('No wallet found on this device. Register before backing up.');
  }

  const publicKey = await AsyncStorage.getItem(PUBLIC_KEY_KEY);
  const signers = overrides.signers ?? (publicKey ? [{ index: 0, publicKey }] : []);

  return {
    version: 1,
    address,
    signers,
    settings: overrides.settings ?? (await readSettings()),
    factoryAddress:
      overrides.factoryAddress || process.env['EXPO_PUBLIC_FACTORY_CONTRACT_ID']?.trim() || undefined,
    networkPassphrase:
      overrides.networkPassphrase
      || process.env['EXPO_PUBLIC_NETWORK_PASSPHRASE']?.trim()
      || TESTNET_PASSPHRASE,
    rpId: overrides.rpId || process.env['EXPO_PUBLIC_RP_ID']?.trim() || undefined,
    createdAt: overrides.createdAt ?? Date.now(),
  };
}

// ── Filesystem backend ───────────────────────────────────────────────────────────

/**
 * Build the storage id an export is filed under. Includes a truncated address
 * and a timestamp so repeat exports do not silently overwrite each other in
 * whatever folder the user saves them to. The id doubles as the filename stem,
 * so what the user sees in the share sheet is what is on disk.
 */
export function buildBackupExportId(address: string, at = new Date()): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const shortAddress = address.slice(0, 8) || 'wallet';
  return `veil-${shortAddress}-${stamp}`;
}

/**
 * A {@link BackupStorageBackend} that stores envelopes as files in the app's
 * cache directory. Only ciphertext is ever written.
 *
 * The cache directory is used deliberately: the file is a hand-off to the share
 * sheet, not durable storage. The user's chosen destination is the real backup,
 * and anything left behind can be reclaimed by the OS.
 */
export class FileBackupBackend implements BackupStorageBackend {
  private readonly directory: Directory;

  /** Maps the backend `id` handed in by `createBackup` to the file written. */
  readonly files = new Map<string, File>();

  constructor(directory?: Directory) {
    this.directory = directory ?? new Directory(Paths.cache, EXPORT_DIR_NAME);
  }

  /** Resolve the file an id maps to. The id doubles as the filename stem. */
  private fileFor(id: string): File {
    if (!id || /[\\/]|\.\./.test(id)) {
      throw new BackupError(`Invalid backup id "${id}" — ids are used as filenames`);
    }
    return new File(this.directory, `${id}${BACKUP_FILE_EXTENSION}`);
  }

  async put(id: string, blob: string): Promise<void> {
    const file = this.fileFor(id);
    file.create({ overwrite: true, intermediates: true });
    file.write(blob);
    this.files.set(id, file);
  }

  async get(id: string): Promise<string | null> {
    const file = this.fileFor(id);
    return file.exists ? file.text() : null;
  }

  async remove(id: string): Promise<void> {
    const file = this.fileFor(id);
    if (file.exists) file.delete();
    this.files.delete(id);
  }
}

// ── Export ───────────────────────────────────────────────────────────────────────

export type BackupExport = {
  /** Storage id the envelope was written under; also the filename stem. */
  id: string;
  /** The encrypted envelope that was written. */
  encrypted: EncryptedBackup;
  /** `file://` URI of the written envelope. */
  uri: string;
  /** Name of the file on disk, as the share sheet will present it. */
  filename: string;
};

/**
 * Encrypt this device's wallet metadata and write the sealed envelope to a file.
 *
 * The passphrase is stretched with PBKDF2 on the JS thread, which takes a
 * noticeable moment on device — call this from a busy state, and let a frame
 * paint first so the spinner is visible.
 *
 * @param secret A user passphrase, or a raw 32-byte PRF-derived key.
 */
export async function exportBackupToFile(
  secret: BackupSecret,
  opts: {
    backend?: FileBackupBackend;
    metadata?: Partial<WalletBackupMetadata>;
    /** Override the filename stem; defaults to {@link buildBackupExportId}. */
    id?: string;
    iterations?: number;
  } = {}
): Promise<BackupExport> {
  const backend = opts.backend ?? new FileBackupBackend();
  const metadata = await collectWalletMetadata(opts.metadata);
  const { id, encrypted } = await createBackup(metadata, secret, backend, {
    id: opts.id ?? buildBackupExportId(metadata.address),
    iterations: opts.iterations,
  });

  const file = backend.files.get(id);
  if (!file) throw new BackupError('Backup was encrypted but no file was written');

  return { id, encrypted, uri: file.uri, filename: file.name };
}

/**
 * Offer an exported backup to the system share sheet so the user can save it to
 * Files, a password manager, or a cloud drive.
 *
 * @returns `false` when the platform has no sharing UI (the file is still on
 *          disk at `uri`, so the caller can surface the path instead).
 */
export async function shareBackupFile(uri: string, filename?: string): Promise<boolean> {
  if (!(await Sharing.isAvailableAsync())) return false;
  await Sharing.shareAsync(uri, {
    mimeType: 'application/json',
    UTI: 'public.json',
    dialogTitle: filename ? `Save ${filename}` : 'Save your Veil backup',
  });
  return true;
}

// ── Import ───────────────────────────────────────────────────────────────────────

/** A backup file the user selected from the system picker. */
export type PickedBackupFile = {
  /** Local `file://` URI of the (cached copy of the) selected file. */
  uri: string;
  /** The file's display name, for showing back to the user. */
  name: string;
};

/**
 * Open the system document picker so the user can choose a backup file.
 *
 * The filter is deliberately wide. Exported backups carry a compound
 * `.veilbackup.json` extension that Android does not reliably map to a MIME
 * type, and a narrow filter would grey out the very file the user came to pick.
 * Nothing is trusted on the strength of its name anyway — {@link decryptBackup}
 * authenticates the contents, and that is the check that matters.
 *
 * @returns The picked file, or `null` if the user cancelled.
 */
export async function pickBackupFile(): Promise<PickedBackupFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;

  const asset = result.assets?.[0];
  if (!asset?.uri) return null;
  return { uri: asset.uri, name: asset.name };
}

/** Read a backup file's raw contents from a local URI. */
export async function readBackupFile(uri: string): Promise<string> {
  const file = new File(uri);
  if (!file.exists) throw new BackupError('That backup file is no longer available.');
  return file.text();
}

/** Write the non-secret parts of a restored backup into device storage. */
export async function persistRestoredState(metadata: WalletBackupMetadata): Promise<void> {
  const entries: Record<string, string> = { [ADDRESS_KEY]: metadata.address };

  const primary = metadata.signers[0]?.publicKey;
  if (primary) entries[PUBLIC_KEY_KEY] = primary;
  if (metadata.settings) entries[SETTINGS_KEY] = JSON.stringify(metadata.settings);

  // `multiSet` (array of [key, value] tuples) is the batch API in async-storage
  // 2.x (SDK 54); the record-shaped `setMany` only existed in 3.x.
  await AsyncStorage.multiSet(Object.entries(entries));
}

/** A passkey enrolled on this device, to be bound as an additional signer. */
export type EnrolledSigner = {
  /** Hex-encoded uncompressed P-256 public key (65 bytes). */
  publicKey: string;
  /** Base64url credential id of the enrolled passkey. */
  credentialId: string;
};

export type RestoreResult = {
  /** The decrypted metadata, with the new signer bound in when one was enrolled. */
  metadata: WalletBackupMetadata;
  /** The name of the file that was restored from. */
  filename: string;
  /**
   * The signer enrolled on this device, when an enroller was supplied. The
   * caller must still add `publicKey` as an on-chain signer for this device to
   * be able to authorise transactions.
   */
  newSigner?: EnrolledSigner;
};

/**
 * Restore a wallet from a backup file: read it, decrypt it, write the wallet
 * state to device storage, and bind a freshly enrolled signer if one is offered.
 *
 * Nothing is persisted until decryption succeeds, so a wrong passphrase or a
 * damaged file leaves whatever is already on the device untouched.
 *
 * Enrolling a passkey is left to the caller through `enrollSigner`: the mobile
 * app has no registration flow yet, and the web wallet takes the same shape —
 * it returns the restored metadata unbound when WebAuthn is not available. The
 * on-chain `add_signer` call is the caller's job either way.
 *
 * @throws {BackupTamperError} if the file fails authentication — wrong
 *                             passphrase, or altered bytes.
 * @throws {BackupError}       if the file is not a backup envelope at all.
 */
export async function restoreFromFile(
  file: PickedBackupFile,
  secret: BackupSecret,
  opts: { enrollSigner?: () => Promise<EnrolledSigner> } = {}
): Promise<RestoreResult> {
  const blob = await readBackupFile(file.uri);
  const metadata = decryptBackup(deserializeBackup(blob), secret);

  await persistRestoredState(metadata);

  if (!opts.enrollSigner) return { metadata, filename: file.name };

  const newSigner = await opts.enrollSigner();
  return {
    metadata: bindNewSigner(metadata, newSigner.publicKey),
    filename: file.name,
    newSigner,
  };
}
