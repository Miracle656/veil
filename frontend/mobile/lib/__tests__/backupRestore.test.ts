/**
 * Backup-file sign-in (V192 / #765).
 *
 * After decryption the passkey on this device must verify against the restored
 * wallet's on-chain signer set — the same check V191 introduces for address
 * sign-in. A backup proves what the wallet *was*, not that this device can
 * sign for it.
 *
 * Pinned here:
 *  - wrong passphrase / altered file raises BackupTamperError with no state written
 *  - non-signer passkey is refused with a SEP-30 message and no state written
 *  - cancelled prompt and undeployed-vs-unreachable read distinctly, writing nothing
 *  - success persists and lands signed in (address + credential + fee-payer)
 */

const mockReadSigners = jest.fn();
const mockDiscover = jest.fn();
const mockPersist = jest.fn();
const mockReadBlob = jest.fn();
const mockSetWalletAddress = jest.fn();
const mockSetSignerSecret = jest.fn();
const mockSetPasskeyCredential = jest.fn();
const mockWriteBreadcrumbs = jest.fn();
const mockMultiSet = jest.fn();
const mockGetNetworkName = jest.fn();

jest.mock('expo-crypto', () => ({
  getRandomBytes: (byteCount: number) =>
    Uint8Array.from({ length: byteCount }, (_, i) => (i * 31 + 7) & 0xff),
}));

jest.mock('../signers', () => {
  const actual = jest.requireActual('../signers');
  return { ...actual, readSigners: (...a: unknown[]) => mockReadSigners(...a) };
});
jest.mock('../passkey', () => ({
  discoverWithPrf: (...a: unknown[]) => mockDiscover(...a),
}));
jest.mock('../backupFile', () => ({
  persistRestoredState: (...a: unknown[]) => mockPersist(...a),
  readBackupFile: (...a: unknown[]) => mockReadBlob(...a),
  pickBackupFile: jest.fn(),
  restoreFromFile: jest.fn(),
}));
jest.mock('../walletStore', () => ({
  setWalletAddress: (...a: unknown[]) => mockSetWalletAddress(...a),
  setSignerSecret: (...a: unknown[]) => mockSetSignerSecret(...a),
  setPasskeyCredential: (...a: unknown[]) => mockSetPasskeyCredential(...a),
}));
jest.mock('../walletBreadcrumbs', () => ({
  writeBreadcrumbs: (...a: unknown[]) => mockWriteBreadcrumbs(...a),
}));
jest.mock('../network', () => ({
  getNetworkName: () => mockGetNetworkName(),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
    multiSet: (...a: unknown[]) => mockMultiSet(...a),
  },
}));

import { p256 } from '@noble/curves/p256.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Keypair, StrKey } from '@stellar/stellar-sdk';

import { encryptBackup, serializeBackup, BackupTamperError } from '../backup';
import {
  BACKUP_SIGNER_MISMATCH_MESSAGE,
  restoreBackupWithSignerCheck,
} from '../backupRestore';
import { WalletContractNotFoundError } from '../signers';
import type { DiscoveredPasskey } from '../passkey';

const PASSPHRASE = 'correct horse battery staple';
const TEST_ITERATIONS = 1_000;
const WALLET = StrKey.encodeContract(Buffer.alloc(32, 7));
const REGISTERED = new Uint8Array(32).fill(7);
const INTRUDER = new Uint8Array(32).fill(9);
const FILE = { uri: 'file://backup.veilbackup.json', name: 'backup.veilbackup.json' };

function signerOf(privateKey: Uint8Array) {
  return {
    index: 0,
    publicKey: Buffer.from(p256.getPublicKey(privateKey, false)).toString('hex'),
  };
}

function assertionOf(privateKey: Uint8Array, prf: Uint8Array | null = null): DiscoveredPasskey {
  const authData = new Uint8Array(37);
  authData.set(sha256(new TextEncoder().encode('app.useveilapp.xyz')), 0);
  authData[32] = 0x05;
  const clientDataJSON = new TextEncoder().encode(
    JSON.stringify({
      type: 'webauthn.get',
      challenge: 'dGVzdA',
      origin: 'app.useveilapp.xyz',
      crossOrigin: false,
    }),
  );
  const verificationData = new Uint8Array(authData.length + 32);
  verificationData.set(authData, 0);
  verificationData.set(sha256(clientDataJSON), authData.length);
  const signature = p256.sign(verificationData, privateKey, { prehash: true }).toCompactRawBytes();
  return {
    credentialId: 'test-credential',
    authData,
    clientDataJSON,
    signature: new Uint8Array(signature),
    prf,
  };
}

function sealBlob(passphrase: string = PASSPHRASE) {
  const metadata = {
    version: 1,
    address: WALLET,
    signers: [signerOf(REGISTERED)],
    networkPassphrase: 'Test SDF Network ; September 2015',
    createdAt: 1_700_000_000_000,
  };
  return serializeBackup(encryptBackup(metadata, passphrase, { iterations: TEST_ITERATIONS }));
}

function flipBit(base64: string): string {
  const bytes = Buffer.from(base64, 'base64');
  bytes[0] ^= 0x01;
  return bytes.toString('base64');
}

beforeEach(() => {
  jest.resetAllMocks();
  mockGetNetworkName.mockReturnValue('testnet');
  mockMultiSet.mockResolvedValue(undefined);
  mockWriteBreadcrumbs.mockResolvedValue(undefined);
  mockPersist.mockResolvedValue(undefined);
  mockSetWalletAddress.mockResolvedValue(undefined);
  mockSetSignerSecret.mockResolvedValue(undefined);
  mockSetPasskeyCredential.mockResolvedValue(undefined);
  mockReadBlob.mockResolvedValue(sealBlob());
});

function expectNoWrites() {
  expect(mockPersist).not.toHaveBeenCalled();
  expect(mockSetWalletAddress).not.toHaveBeenCalled();
  expect(mockSetSignerSecret).not.toHaveBeenCalled();
  expect(mockSetPasskeyCredential).not.toHaveBeenCalled();
  expect(mockMultiSet).not.toHaveBeenCalled();
  expect(mockWriteBreadcrumbs).not.toHaveBeenCalled();
}

describe('restoreBackupWithSignerCheck', () => {
  it('restores and signs in when the device passkey is a signer, deriving the fee-payer from PRF', async () => {
    const prfSeed = new Uint8Array(32).fill(11);
    mockReadSigners.mockResolvedValue([signerOf(REGISTERED)]);
    mockDiscover.mockResolvedValue(assertionOf(REGISTERED, prfSeed));

    const result = await restoreBackupWithSignerCheck(FILE, PASSPHRASE);

    expect(result.address).toBe(WALLET);
    expect(result.filename).toBe(FILE.name);
    expect(result.recoverable).toBe(true);
    expect(result.credentialId).toBe('test-credential');
    expect(mockPersist).toHaveBeenCalledTimes(1);
    expect(mockSetWalletAddress).toHaveBeenCalledWith(WALLET);
    expect(mockSetPasskeyCredential).toHaveBeenCalledWith(
      'test-credential',
      signerOf(REGISTERED).publicKey,
    );
    expect(mockSetSignerSecret).toHaveBeenCalledWith(
      Keypair.fromRawEd25519Seed(Buffer.from(prfSeed)).secret(),
    );
  });

  it('falls back to a fresh random fee-payer when PRF is unavailable, like address sign-in', async () => {
    mockReadSigners.mockResolvedValue([signerOf(REGISTERED)]);
    mockDiscover.mockResolvedValue(assertionOf(REGISTERED, null));

    const result = await restoreBackupWithSignerCheck(FILE, PASSPHRASE);

    expect(result.recoverable).toBe(false);
    const secret = mockSetSignerSecret.mock.calls[0][0];
    expect(() => Keypair.fromSecret(secret)).not.toThrow();
  });

  it('leaves device state untouched on the wrong passphrase (BackupTamperError)', async () => {
    mockReadSigners.mockResolvedValue([signerOf(REGISTERED)]);
    mockDiscover.mockResolvedValue(assertionOf(REGISTERED));

    await expect(restoreBackupWithSignerCheck(FILE, 'not the passphrase')).rejects.toThrow(
      BackupTamperError,
    );
    expect(mockDiscover).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('leaves device state untouched when the file was altered', async () => {
    const envelope = JSON.parse(sealBlob());
    envelope.ciphertext = flipBit(envelope.ciphertext);
    mockReadBlob.mockResolvedValue(JSON.stringify(envelope));
    mockReadSigners.mockResolvedValue([signerOf(REGISTERED)]);
    mockDiscover.mockResolvedValue(assertionOf(REGISTERED));

    await expect(restoreBackupWithSignerCheck(FILE, PASSPHRASE)).rejects.toThrow(
      BackupTamperError,
    );
    expect(mockDiscover).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('refuses a backup whose wallet does not list this device passkey, naming the SEP-30 path', async () => {
    mockReadSigners.mockResolvedValue([signerOf(REGISTERED)]);
    mockDiscover.mockResolvedValue(assertionOf(INTRUDER));

    await expect(restoreBackupWithSignerCheck(FILE, PASSPHRASE)).rejects.toThrow(/SEP-30/);
    await expect(restoreBackupWithSignerCheck(FILE, PASSPHRASE)).rejects.toThrow(
      BACKUP_SIGNER_MISMATCH_MESSAGE,
    );
    expectNoWrites();
  });

  it('reports a cancelled passkey prompt and writes nothing', async () => {
    mockReadSigners.mockResolvedValue([signerOf(REGISTERED)]);
    mockDiscover.mockResolvedValue(null);

    await expect(restoreBackupWithSignerCheck(FILE, PASSPHRASE)).rejects.toThrow(/cancelled/);
    expectNoWrites();
  });

  it('distinguishes an undeployed wallet from an unreachable network', async () => {
    mockReadSigners.mockRejectedValueOnce(new WalletContractNotFoundError(WALLET));
    await expect(restoreBackupWithSignerCheck(FILE, PASSPHRASE)).rejects.toThrow(
      /No deployed wallet/,
    );
    expect(mockDiscover).not.toHaveBeenCalled();

    mockReadSigners.mockRejectedValueOnce(new Error('Failed to fetch'));
    await expect(restoreBackupWithSignerCheck(FILE, PASSPHRASE)).rejects.toThrow(
      /Could not reach the network/,
    );
    expectNoWrites();
  });
});
