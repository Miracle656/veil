/**
 * Backup-file sign-in (V192 / #765).
 *
 * The encrypted backup already holds the `C…` address and the passkey public
 * key, and `restoreFromFile` already decrypts and persists it — but only
 * inside Settings → Wallet backup, which a user on a new phone cannot reach
 * because they are not signed in.
 *
 * This module is the sign-in half: decrypt a user-picked backup file, then run
 * the same signer check V191 introduces for address sign-in — the passkey on
 * this device must verify against the restored wallet's on-chain signer set.
 * A backup proves what the wallet *was*, not that this device can sign for it.
 * A mismatch is refused with a message that names the SEP-30 path, and no
 * wallet state is written; a wrong passphrase or altered file raises
 * `BackupTamperError` before anything is persisted, leaving existing device
 * state untouched.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Keypair } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

import {
  BackupTamperError,
  decryptBackup,
  deserializeBackup,
  type WalletBackupMetadata,
} from './backup';
import { persistRestoredState, readBackupFile, type PickedBackupFile } from './backupFile';
import { getNetworkName } from './network';
import { discoverWithPrf, type DiscoveredPasskey } from './passkey';
import {
  FEE_PAYER_PRF_SALT,
  findMatchingSigner,
} from './passkeyLogin';
import { readSigners, WalletContractNotFoundError, type WalletSigner } from './signers';
import { writeBreadcrumbs } from './walletBreadcrumbs';
import {
  setPasskeyCredential,
  setSignerSecret,
  setWalletAddress,
} from './walletStore';

export const BACKUP_SIGNER_MISMATCH_MESSAGE =
  "This backup's wallet does not list this device's passkey as a signer. " +
  'If the passkey was lost with the old device, use SEP-30 recovery (/recover) ' +
  'with your recovery servers to bind a new passkey as a signer.';

export const BACKUP_WALLET_NOT_DEPLOYED_MESSAGE =
  'No deployed wallet is at the address in this backup on this network. Check the selected network, then try again.';

export const BACKUP_NETWORK_UNREACHABLE_MESSAGE =
  'Could not reach the network to check this backup. Check your connection and try again.';

export const BACKUP_PASSKEY_CANCELLED_MESSAGE = 'Passkey sign-in was cancelled.';

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export type BackupRestoreResult = {
  metadata: WalletBackupMetadata;
  filename: string;
  address: string;
  credentialId: string;
  publicKeyHex: string;
  /**
   * Whether the fee-payer was derived from the passkey's PRF output (so the
   * wallet stays recoverable from the passkey elsewhere) rather than a fresh
   * random key. A `false` here is exactly the fee-payer gas gap #766 surfaces
   * on the dashboard.
   */
  recoverable: boolean;
};

export type BackupRestoreDeps = {
  readSignersFn?: (address: string) => Promise<WalletSigner[]>;
  discoverFn?: (salt: Uint8Array) => Promise<DiscoveredPasskey | null>;
  persistFn?: (metadata: WalletBackupMetadata) => Promise<void>;
  setWalletAddressFn?: (address: string) => Promise<void>;
  setSignerSecretFn?: (secret: string) => Promise<void>;
  setPasskeyCredentialFn?: (credentialId: string, publicKeyHex: string) => Promise<void>;
  writeBreadcrumbsFn?: (feePayerSecret: string, address: string, publicKey: Uint8Array) => Promise<void>;
  writeSdkMirrorFn?: (address: string, credentialId: string, publicKeyHex: string) => Promise<void>;
};

async function defaultWriteSdkMirror(
  address: string,
  credentialId: string,
  publicKeyHex: string,
): Promise<void> {
  const suffix = getNetworkName() === 'mainnet' ? '_mainnet' : '';
  await AsyncStorage.multiSet([
    [`invisible_wallet_address${suffix}`, address],
    [`invisible_wallet_key_id${suffix}`, credentialId],
    [`invisible_wallet_public_key${suffix}`, publicKeyHex],
  ]);
}

/**
 * Restore a wallet from a backup file with the V191 signer check.
 *
 * Nothing is persisted until both decryption AND the signer check succeed, so
 * a wrong passphrase, an altered file, a cancelled prompt, or a non-signer
 * passkey all leave whatever is already on the device untouched.
 *
 * @throws {BackupTamperError} wrong passphrase or altered bytes.
 * @throws {BackupError} file is not a backup envelope at all.
 * @throws {Error} with {@link BACKUP_SIGNER_MISMATCH_MESSAGE} when this
 *   device's passkey is not in the wallet's on-chain signer set.
 */
export async function restoreBackupWithSignerCheck(
  file: PickedBackupFile,
  secret: string | Uint8Array,
  deps: BackupRestoreDeps = {},
): Promise<BackupRestoreResult> {
  const {
    readSignersFn = readSigners,
    discoverFn = discoverWithPrf,
    persistFn = persistRestoredState,
    setWalletAddressFn = setWalletAddress,
    setSignerSecretFn = setSignerSecret,
    setPasskeyCredentialFn = setPasskeyCredential,
    writeBreadcrumbsFn = writeBreadcrumbs,
    writeSdkMirrorFn = defaultWriteSdkMirror,
  } = deps;

  // ── Decrypt first, persist nothing yet. A BackupTamperError here means the
  //    passphrase is wrong or the bytes were altered — existing device state
  //    is untouched because no writer has run. ──
  const blob = await readBackupFile(file.uri);
  const metadata = decryptBackup(deserializeBackup(blob), secret);
  if (!metadata || typeof metadata.address !== 'string' || !Array.isArray(metadata.signers)) {
    throw new BackupTamperError('Decrypted backup is missing required fields');
  }
  const address = metadata.address;

  // ── Resolve before trusting: "no wallet" vs "network down", and never ask
  //    for a passkey until a wallet has been found to get into. ──
  let signers: WalletSigner[];
  try {
    signers = await readSignersFn(address);
  } catch (error) {
    if (error instanceof WalletContractNotFoundError) {
      throw new Error(BACKUP_WALLET_NOT_DEPLOYED_MESSAGE);
    }
    throw new Error(BACKUP_NETWORK_UNREACHABLE_MESSAGE);
  }

  // ── Prove this device holds one of the registered signers. ──
  const picked = await discoverFn(FEE_PAYER_PRF_SALT);
  if (!picked) {
    throw new Error(BACKUP_PASSKEY_CANCELLED_MESSAGE);
  }
  const matched = findMatchingSigner(picked, signers);
  if (!matched) {
    throw new Error(BACKUP_SIGNER_MISMATCH_MESSAGE);
  }

  // ── Everything checked; only now adopt the wallet. ──
  const publicKeyHex = toHex(matched);
  const prfSeed = picked.prf && picked.prf.length >= 32 ? picked.prf.subarray(0, 32) : null;
  const feePayer = prfSeed
    ? Keypair.fromRawEd25519Seed(Buffer.from(prfSeed))
    : Keypair.random();
  const recoverable = prfSeed !== null;

  await persistFn(metadata);
  await Promise.all([
    setWalletAddressFn(address),
    setSignerSecretFn(feePayer.secret()),
    setPasskeyCredentialFn(picked.credentialId, publicKeyHex),
  ]);
  await writeSdkMirrorFn(address, picked.credentialId, publicKeyHex).catch(() => undefined);
  void writeBreadcrumbsFn(feePayer.secret(), address, matched).catch(() => undefined);

  return { metadata, filename: file.name, address, credentialId: picked.credentialId, publicKeyHex, recoverable };
}
