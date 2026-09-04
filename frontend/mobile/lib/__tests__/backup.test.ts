/**
 * Tests for the React Native backup port.
 *
 * Two things matter here and both are security properties rather than features:
 * the guard that keeps key material out of an exported file, and the promise
 * that the envelope this port writes is the same envelope `sdk/src/backup.ts`
 * writes. The interop suite therefore decrypts our output with Web Crypto, the
 * exact primitive the SDK uses.
 */

// expo-crypto is a native module; jest-expo stubs it out, so randomness is
// supplied here. The values only need to be well-formed, not unpredictable.
jest.mock('expo-crypto', () => ({
  getRandomBytes: (byteCount: number) =>
    Uint8Array.from({ length: byteCount }, (_, i) => (i * 31 + 7) & 0xff),
}));

import {
  BACKUP_FORMAT_VERSION,
  BackupError,
  BackupTamperError,
  assertNoSecretMaterial,
  createBackup,
  decryptBackup,
  deriveBackupId,
  encryptBackup,
  serializeBackup,
  type BackupStorageBackend,
  type EncryptedBackup,
  type WalletBackupMetadata,
} from '../backup';

const PASSPHRASE = 'correct horse battery staple';

// Keep the work factor low so the suite stays fast; the code path is identical.
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

/** Decrypt an envelope the way the SDK does — Web Crypto, no shared code. */
async function decryptWithWebCrypto(
  envelope: EncryptedBackup,
  passphrase: string
): Promise<unknown> {
  const b64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'));
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: b64(envelope.salt!),
      iterations: envelope.iterations!,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64(envelope.iv) },
    key,
    b64(envelope.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

describe('assertNoSecretMaterial', () => {
  it('accepts metadata that only carries public wallet state', () => {
    expect(() => assertNoSecretMaterial(makeMetadata())).not.toThrow();
  });

  it.each([
    ['privateKey', { privateKey: 'deadbeef' }],
    ['secretKey', { secretKey: 'deadbeef' }],
    ['mnemonic', { mnemonic: 'abandon abandon ability' }],
    ['seedPhrase', { seedPhrase: 'abandon abandon ability' }],
    ['keypair', { keypair: {} }],
    ['walletSecret', { walletSecret: 'deadbeef' }],
    ['PRIVATE_KEY', { PRIVATE_KEY: 'deadbeef' }],
  ])('rejects a top-level %s field', (_name, extra) => {
    expect(() => assertNoSecretMaterial({ ...makeMetadata(), ...extra })).toThrow(BackupError);
  });

  it('rejects secret material nested inside settings', () => {
    const metadata = makeMetadata({ settings: { device: { recoverySeed: 'abandon abandon' } } });
    expect(() => assertNoSecretMaterial(metadata)).toThrow(/settings\.device\.recoverySeed/);
  });

  it('rejects secret material nested inside an array', () => {
    expect(() => assertNoSecretMaterial({ items: [{ ok: 1 }, { mnemonic: 'x' }] })).toThrow(
      /items\[1\]\.mnemonic/
    );
  });

  it('does not mistake the public Stellar network passphrase for a secret', () => {
    expect(() =>
      assertNoSecretMaterial({ networkPassphrase: 'Test SDF Network ; September 2015' })
    ).not.toThrow();
  });
});

describe('encryptBackup', () => {
  it('refuses to seal metadata carrying secret material', () => {
    const metadata = { ...makeMetadata(), mnemonic: 'abandon abandon ability' };
    expect(() => encryptBackup(metadata, PASSPHRASE, { iterations: TEST_ITERATIONS })).toThrow(
      BackupError
    );
  });

  it('produces a PBKDF2 envelope for a passphrase', () => {
    const envelope = encryptBackup(makeMetadata(), PASSPHRASE, { iterations: TEST_ITERATIONS });
    expect(envelope).toMatchObject({
      version: BACKUP_FORMAT_VERSION,
      algorithm: 'AES-GCM',
      kdf: 'PBKDF2',
      iterations: TEST_ITERATIONS,
    });
    expect(Buffer.from(envelope.salt!, 'base64')).toHaveLength(16);
    expect(Buffer.from(envelope.iv, 'base64')).toHaveLength(12);
  });

  it('produces a keyless envelope for a raw 32-byte key', () => {
    const envelope = encryptBackup(makeMetadata(), new Uint8Array(32).fill(9));
    expect(envelope.kdf).toBe('none');
    expect(envelope.salt).toBeUndefined();
    expect(envelope.iterations).toBeUndefined();
  });

  it('rejects a raw key that is not 32 bytes', () => {
    expect(() => encryptBackup(makeMetadata(), new Uint8Array(16))).toThrow(BackupError);
  });

  it('appends the 16-byte GCM authentication tag to the ciphertext', () => {
    const metadata = makeMetadata();
    const envelope = encryptBackup(metadata, PASSPHRASE, { iterations: TEST_ITERATIONS });
    const plaintextLength = new TextEncoder().encode(JSON.stringify(metadata)).length;
    expect(Buffer.from(envelope.ciphertext, 'base64')).toHaveLength(plaintextLength + 16);
  });

  it('never leaks plaintext metadata into the envelope', () => {
    const metadata = makeMetadata();
    const blob = serializeBackup(encryptBackup(metadata, PASSPHRASE, { iterations: TEST_ITERATIONS }));
    expect(blob).not.toContain(metadata.address);
    expect(blob).not.toContain(metadata.signers[0].publicKey);
  });
});

describe('backward compatibility — version-1 envelopes', () => {
  it('decrypts a version-1 envelope at 210,000 iterations', () => {
    const metadata = makeMetadata();
    // Encrypt at the old work factor and manually downgrade the version to
    // simulate an envelope written before the PBKDF2 iteration bump.
    const envelope = encryptBackup(metadata, PASSPHRASE, { iterations: 210_000 });
    const v1Envelope = { ...envelope, version: 1 };

    const restored = decryptBackup(v1Envelope, PASSPHRASE);
    expect(restored).toEqual(metadata);
  });

  it('rejects versions other than 1 or the current format', () => {
    const envelope = encryptBackup(makeMetadata(), PASSPHRASE, { iterations: TEST_ITERATIONS });
    const brokenEnvelope = { ...envelope, version: 3 } as EncryptedBackup;
    expect(() => decryptBackup(brokenEnvelope, PASSPHRASE)).toThrow(BackupError);
  });
});

describe('SDK wire-format compatibility', () => {
  it('emits an envelope the SDK Web Crypto path can decrypt', async () => {
    const metadata = makeMetadata();
    const envelope = encryptBackup(metadata, PASSPHRASE, { iterations: TEST_ITERATIONS });
    await expect(decryptWithWebCrypto(envelope, PASSPHRASE)).resolves.toEqual(metadata);
  });

  it('fails authentication when the ciphertext is altered', async () => {
    const envelope = encryptBackup(makeMetadata(), PASSPHRASE, { iterations: TEST_ITERATIONS });
    const bytes = Buffer.from(envelope.ciphertext, 'base64');
    bytes[0] ^= 0x01;
    const tampered = { ...envelope, ciphertext: bytes.toString('base64') };
    await expect(decryptWithWebCrypto(tampered, PASSPHRASE)).rejects.toThrow();
  });
});

describe('deriveBackupId', () => {
  it('is stable for a given address', () => {
    const address = makeMetadata().address;
    expect(deriveBackupId(address)).toBe(deriveBackupId(address));
  });

  it('differs between addresses and stays filename-safe', () => {
    const a = deriveBackupId('CAAAA');
    const b = deriveBackupId('CBBBB');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^backup_[A-Za-z0-9]{24}$/);
  });
});

describe('createBackup', () => {
  it('hands only ciphertext to the backend and defaults the id to the address digest', async () => {
    const written = new Map<string, string>();
    const backend: BackupStorageBackend = {
      async put(id, blob) {
        written.set(id, blob);
      },
      async get(id) {
        return written.get(id) ?? null;
      },
    };

    const metadata = makeMetadata();
    const { id, encrypted } = await createBackup(metadata, PASSPHRASE, backend, {
      iterations: TEST_ITERATIONS,
    });

    expect(id).toBe(deriveBackupId(metadata.address));
    expect(written.get(id)).toBe(serializeBackup(encrypted));
    expect(written.get(id)).not.toContain(metadata.address);
  });

  it('honours an explicit storage id', async () => {
    const written = new Map<string, string>();
    const backend: BackupStorageBackend = {
      async put(id, blob) {
        written.set(id, blob);
      },
      async get(id) {
        return written.get(id) ?? null;
      },
    };

    await createBackup(makeMetadata(), PASSPHRASE, backend, {
      id: 'veil-CBQHNQCD-2026-01-01T00-00-00',
      iterations: TEST_ITERATIONS,
    });

    expect([...written.keys()]).toEqual(['veil-CBQHNQCD-2026-01-01T00-00-00']);
  });
});
