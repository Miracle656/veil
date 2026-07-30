/**
 * Tests for the restore half of the backup port.
 *
 * The property that matters most is negative: a backup that has been altered,
 * or opened with the wrong passphrase, must fail loudly with BackupTamperError
 * rather than yield partial or plausible-looking wallet state. Every field of
 * the envelope is authenticated, so every field is tested.
 */

jest.mock('expo-crypto', () => ({
  getRandomBytes: (byteCount: number) =>
    Uint8Array.from({ length: byteCount }, (_, i) => (i * 31 + 7) & 0xff),
}));

import {
  BackupError,
  BackupTamperError,
  bindNewSigner,
  createBackup,
  decryptBackup,
  deserializeBackup,
  encryptBackup,
  restoreBackup,
  serializeBackup,
  type BackupStorageBackend,
  type EncryptedBackup,
  type WalletBackupMetadata,
} from '../backup';

const PASSPHRASE = 'correct horse battery staple';
const TEST_ITERATIONS = 1_000;

function makeMetadata(overrides: Partial<WalletBackupMetadata> = {}): WalletBackupMetadata {
  return {
    version: 1,
    address: 'CBQHNQCDPPQYQKQ6L4E2QJ7A5PZQ4XKZ2XPMCF7VHXUMYFPYA3MG5CQ7',
    signers: [{ index: 0, publicKey: '04'.padEnd(130, 'a') }],
    settings: { currency: 'USD' },
    networkPassphrase: 'Test SDF Network ; September 2015',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function seal(metadata = makeMetadata(), secret: string | Uint8Array = PASSPHRASE) {
  return encryptBackup(metadata, secret, { iterations: TEST_ITERATIONS });
}

/** Flip one bit in a base64 field, leaving it well-formed base64. */
function flipBit(base64: string, index = 0): string {
  const bytes = Buffer.from(base64, 'base64');
  bytes[index] ^= 0x01;
  return bytes.toString('base64');
}

/** Build an in-memory backend, pre-seeded with `blobs`. */
function memoryBackend(blobs: Record<string, string> = {}) {
  const store = new Map(Object.entries(blobs));
  const backend: BackupStorageBackend = {
    async put(id, blob) {
      store.set(id, blob);
    },
    async get(id) {
      return store.get(id) ?? null;
    },
  };
  return { backend, store };
}

describe('decryptBackup', () => {
  it('round-trips metadata sealed with a passphrase', () => {
    const metadata = makeMetadata();
    expect(decryptBackup(seal(metadata), PASSPHRASE)).toEqual(metadata);
  });

  it('round-trips metadata sealed with a raw 32-byte key', () => {
    const key = new Uint8Array(32).fill(9);
    const metadata = makeMetadata();
    expect(decryptBackup(encryptBackup(metadata, key), key)).toEqual(metadata);
  });

  it('preserves optional fields exactly', () => {
    const metadata = makeMetadata({
      factoryAddress: 'CFACTORY',
      rpId: 'veil.app',
      settings: { currency: 'EUR', nested: { theme: 'dark' } },
    });
    expect(decryptBackup(seal(metadata), PASSPHRASE)).toEqual(metadata);
  });
});

describe('decryptBackup rejects tampering', () => {
  it('throws BackupTamperError on the wrong passphrase', () => {
    expect(() => decryptBackup(seal(), 'not the passphrase')).toThrow(BackupTamperError);
  });

  it('throws BackupTamperError when the ciphertext is altered', () => {
    const envelope = seal();
    expect(() =>
      decryptBackup({ ...envelope, ciphertext: flipBit(envelope.ciphertext) }, PASSPHRASE)
    ).toThrow(BackupTamperError);
  });

  it('throws BackupTamperError when the authentication tag is altered', () => {
    const envelope = seal();
    const bytes = Buffer.from(envelope.ciphertext, 'base64');
    // The GCM tag is the trailing 16 bytes.
    const tagged = flipBit(envelope.ciphertext, bytes.length - 1);
    expect(() => decryptBackup({ ...envelope, ciphertext: tagged }, PASSPHRASE)).toThrow(
      BackupTamperError
    );
  });

  it('throws BackupTamperError when the IV is altered', () => {
    const envelope = seal();
    expect(() => decryptBackup({ ...envelope, iv: flipBit(envelope.iv) }, PASSPHRASE)).toThrow(
      BackupTamperError
    );
  });

  it('throws BackupTamperError when the salt is altered', () => {
    const envelope = seal();
    expect(() => decryptBackup({ ...envelope, salt: flipBit(envelope.salt!) }, PASSPHRASE)).toThrow(
      BackupTamperError
    );
  });

  it('throws BackupTamperError when the iteration count is altered', () => {
    const envelope = seal();
    expect(() =>
      decryptBackup({ ...envelope, iterations: TEST_ITERATIONS + 1 }, PASSPHRASE)
    ).toThrow(BackupTamperError);
  });

  it('throws BackupTamperError when truncated below the tag length', () => {
    const envelope = seal();
    const bytes = Buffer.from(envelope.ciphertext, 'base64');
    const truncated = bytes.subarray(0, 8).toString('base64');
    expect(() => decryptBackup({ ...envelope, ciphertext: truncated }, PASSPHRASE)).toThrow(
      BackupTamperError
    );
  });

  it('throws BackupTamperError when the plaintext is valid JSON but not a wallet', () => {
    // Seal a well-formed but wallet-less payload, then decrypt it as a backup.
    const notAWallet = { version: 1, hello: 'world' } as unknown as WalletBackupMetadata;
    const envelope = encryptBackup(notAWallet, PASSPHRASE, { iterations: TEST_ITERATIONS });
    expect(() => decryptBackup(envelope, PASSPHRASE)).toThrow(
      /missing required fields/
    );
  });
});

describe('decryptBackup rejects malformed envelopes', () => {
  it('rejects a null envelope', () => {
    expect(() => decryptBackup(null as unknown as EncryptedBackup, PASSPHRASE)).toThrow(
      BackupError
    );
  });

  it('rejects an unsupported envelope version', () => {
    expect(() => decryptBackup({ ...seal(), version: 99 }, PASSPHRASE)).toThrow(
      /Unsupported backup version: 99/
    );
  });

  it('rejects an unsupported algorithm', () => {
    const envelope = { ...seal(), algorithm: 'AES-CBC' } as unknown as EncryptedBackup;
    expect(() => decryptBackup(envelope, PASSPHRASE)).toThrow(/Unsupported backup algorithm/);
  });

  it('rejects a raw key when the envelope wants a passphrase', () => {
    expect(() => decryptBackup(seal(), new Uint8Array(32))).toThrow(/does not match/);
  });

  it('rejects a passphrase when the envelope wants a raw key', () => {
    const envelope = encryptBackup(makeMetadata(), new Uint8Array(32).fill(1));
    expect(() => decryptBackup(envelope, PASSPHRASE)).toThrow(/does not match/);
  });

  it('rejects base64 fields containing illegal characters', () => {
    expect(() => decryptBackup({ ...seal(), iv: 'not base64!!' }, PASSPHRASE)).toThrow(
      /malformed base64/
    );
  });
});

describe('deserializeBackup', () => {
  it('parses what serializeBackup produced', () => {
    const envelope = seal();
    expect(deserializeBackup(serializeBackup(envelope))).toEqual(envelope);
  });

  it('rejects a file that is not JSON', () => {
    expect(() => deserializeBackup('this is not a backup')).toThrow(BackupError);
  });
});

describe('restoreBackup', () => {
  it('fetches and decrypts a stored envelope', async () => {
    const { backend } = memoryBackend();
    const metadata = makeMetadata();
    const { id } = await createBackup(metadata, PASSPHRASE, backend, {
      iterations: TEST_ITERATIONS,
    });
    await expect(restoreBackup(id, PASSPHRASE, backend)).resolves.toEqual(metadata);
  });

  it('throws when the backend holds no blob for the id', async () => {
    const { backend } = memoryBackend();
    await expect(restoreBackup('backup_missing', PASSPHRASE, backend)).rejects.toThrow(
      /No backup found/
    );
  });

  it('surfaces tampering from a stored blob', async () => {
    const envelope = seal();
    const damaged = { ...envelope, ciphertext: flipBit(envelope.ciphertext) };
    const { backend } = memoryBackend({ 'backup_x': serializeBackup(damaged) });
    await expect(restoreBackup('backup_x', PASSPHRASE, backend)).rejects.toThrow(BackupTamperError);
  });
});

describe('bindNewSigner', () => {
  it('appends a new signer at the next free index', () => {
    const metadata = makeMetadata({
      signers: [
        { index: 0, publicKey: 'aa' },
        { index: 3, publicKey: 'bb' },
      ],
    });
    const bound = bindNewSigner(metadata, 'cc');
    expect(bound.signers).toEqual([
      { index: 0, publicKey: 'aa' },
      { index: 3, publicKey: 'bb' },
      { index: 4, publicKey: 'cc' },
    ]);
  });

  it('starts at index 0 for a wallet with no signers', () => {
    const bound = bindNewSigner(makeMetadata({ signers: [] }), 'cc');
    expect(bound.signers).toEqual([{ index: 0, publicKey: 'cc' }]);
  });

  it('does not duplicate a signer that is already bound', () => {
    const metadata = makeMetadata({ signers: [{ index: 0, publicKey: 'aa' }] });
    expect(bindNewSigner(metadata, 'aa').signers).toEqual([{ index: 0, publicKey: 'aa' }]);
  });

  it('does not mutate the input metadata', () => {
    const metadata = makeMetadata();
    const before = JSON.parse(JSON.stringify(metadata));
    bindNewSigner(metadata, 'cc');
    expect(metadata).toEqual(before);
  });

  it('requires a public key', () => {
    expect(() => bindNewSigner(makeMetadata(), '')).toThrow(BackupError);
  });

  it('survives a decrypt round-trip', () => {
    const bound = bindNewSigner(decryptBackup(seal(), PASSPHRASE), 'cc');
    expect(decryptBackup(seal(bound), PASSPHRASE)).toEqual(bound);
  });
});
