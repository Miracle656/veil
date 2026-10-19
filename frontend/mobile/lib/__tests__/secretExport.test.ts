/**
 * #1041 — a classic keypair wallet's key must be able to leave the device on
 * purpose, because an uninstall currently destroys the wallet silently.
 *
 * The tests here are about the two ways that feature could lose someone money:
 *
 *   • revealing a key that is NOT the wallet's (a smart wallet's fee-payer, or
 *     a stale secret under a reused address) — the user imports it, gets a
 *     different account, and believes their wallet is gone;
 *   • the export leaking into the encrypted backup, which is designed to be
 *     safe to drop in a cloud drive precisely because it never holds a secret.
 *
 * `expo-secure-store` is replaced with an in-memory keychain, so the real
 * `lib/walletStore.ts` accessors and the real create/import flows run against
 * it — the round trip below is the production path end to end, not a mock of
 * it. Friendbot is stubbed: nothing here touches a network.
 */

import { Keypair, StrKey } from '@stellar/stellar-sdk';
import AsyncStorage from '@react-native-async-storage/async-storage';

const mockStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) =>
    mockStore.has(key) ? mockStore.get(key)! : null,
  ),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockStore.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockStore.delete(key);
  }),
}));

import {
  requireDeviceUnlock,
  resolveSecretExport,
  walletKind,
  type DeviceAuthenticator,
} from '../secretExport';
import { SecureKey } from '../storage';
import { createTestnetWallet, importTestnetWallet } from '../testnetWallet';
import {
  clearWalletStore,
  getSignerSecret,
  getWalletAddress,
  setPasskeyCredential,
  setSignerSecret,
  setWalletAddress,
} from '../walletStore';
import { assertNoSecretMaterial, BackupError, encryptBackup } from '../backup';
import { collectWalletMetadata } from '../backupFile';

/** A contract address, the way a smart wallet stores one. */
const SMART_ADDRESS = StrKey.encodeContract(Buffer.alloc(32, 4));

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
  // Friendbot is the only network call these flows make; nothing here leaves
  // the process.
  global.fetch = jest.fn(
    async () => ({ ok: true, status: 200, text: async () => '' }),
  ) as never;
});

/** A device that has a working biometric and answers yes. */
const unlockedDevice = (): DeviceAuthenticator => ({
  SecurityLevel: { NONE: 0 },
  getEnrolledLevelAsync: jest.fn(async () => 2),
  authenticateAsync: jest.fn(async () => ({ success: true, error: '' })),
});

// ── Classification ──────────────────────────────────────────────────────────────

describe('walletKind', () => {
  it('calls a G-account a keypair wallet', () => {
    expect(walletKind(Keypair.random().publicKey())).toBe('keypair');
  });

  it('calls a C-address a smart wallet — the same test the spend path uses', () => {
    expect(walletKind(SMART_ADDRESS)).toBe('smart');
  });

  it('has no wallet without an address, and no keypair for a corrupt one', () => {
    expect(walletKind(null)).toBe('none');
    expect(walletKind('')).toBe('none');
    expect(walletKind('not-an-address')).toBe('unknown');
    // A key of the wrong length is not a G-account either.
    expect(walletKind('GABC')).toBe('unknown');
  });
});

// ── The decision ────────────────────────────────────────────────────────────────

describe('resolveSecretExport', () => {
  it('reveals the keypair wallet created on this device', async () => {
    const created = await createTestnetWallet();

    const state = await resolveSecretExport();
    expect(state.status).toBe('revealable');
    if (state.status !== 'revealable') return;
    expect(state.address).toBe(created.address);
    // The secret shown must be the one that derives the address it is shown with.
    expect(Keypair.fromSecret(state.secret).publicKey()).toBe(state.address);
    expect(state.secret).toBe(await getSignerSecret());
  });

  it('offers a smart wallet nothing, and does not read its fee-payer key', async () => {
    // The state a passkey wallet leaves behind: contract address + the PRF-derived
    // fee-payer sitting in the same slot a keypair wallet's secret occupies.
    const feePayer = Keypair.random();
    const feePayerSecret = feePayer.secret();
    await setWalletAddress(SMART_ADDRESS);
    await setSignerSecret(feePayerSecret);
    await setPasskeyCredential('cred-id', 'a1b2c3');

    const state = await resolveSecretExport();
    // The whole shape, not just the status: a refusal that carried a `secret`
    // field would still be a leak.
    expect(state).toEqual({ status: 'smart-wallet', address: SMART_ADDRESS });
    expect(JSON.stringify(state)).not.toContain(feePayerSecret);
  });

  it('refuses when the stored secret does not derive the stored address', async () => {
    const wallet = Keypair.random();
    const other = Keypair.random();
    await setWalletAddress(wallet.publicKey());
    await setSignerSecret(other.secret());

    expect(await resolveSecretExport()).toEqual({
      status: 'secret-mismatch',
      address: wallet.publicKey(),
    });

    // And the key that was refused stays refused.
    const state = await resolveSecretExport();
    expect(JSON.stringify(state)).not.toContain(other.secret());
  });

  it('refuses a malformed secret instead of throwing at the screen', async () => {
    await setWalletAddress(Keypair.random().publicKey());
    await setSignerSecret('S*clearly*not*a*seed');

    expect((await resolveSecretExport()).status).toBe('secret-mismatch');
  });

  it('says so when the address is here but the key is not', async () => {
    const address = Keypair.random().publicKey();
    await setWalletAddress(address);

    expect(await resolveSecretExport()).toEqual({ status: 'no-secret', address });
  });

  it('refuses an address that is neither a contract nor a decodable account', async () => {
    // Not a valid ed25519 key (wrong length, and '0' is outside the base32
    // alphabet), so there is no wallet this key could belong to.
    await setWalletAddress('G0000');
    await setSignerSecret(Keypair.random().secret());

    expect((await resolveSecretExport()).status).toBe('unknown-address');
  });

  it('has nothing to reveal before a wallet exists', async () => {
    expect((await resolveSecretExport()).status).toBe('no-wallet');
  });
});

describe('the entry point’s own test (app/(tabs)/settings.tsx)', () => {
  /** What the settings row asks, exactly: the stored address, classified. */
  const offered = async () => walletKind(await getWalletAddress()) === 'keypair';

  it('offers a keypair wallet and refuses every other wallet', async () => {
    await createTestnetWallet();
    expect(await offered()).toBe(true);

    // A smart wallet must not see the row at all — the fee-payer secret sitting
    // in `veil_signer_secret` is not the wallet's key.
    await clearWalletStore();
    await setWalletAddress(SMART_ADDRESS);
    await setSignerSecret(Keypair.random().secret());
    expect(await offered()).toBe(false);

    await clearWalletStore();
    expect(await offered()).toBe(false);
  });
});

// ── The lock ────────────────────────────────────────────────────────────────────

describe('requireDeviceUnlock', () => {
  /** A device whose enrolled level and answer the test decides. */
  const auth = (over: {
    level?: number;
    success?: boolean;
    error?: string;
    throwOnLevel?: boolean;
    throwOnAuth?: boolean;
  } = {}): DeviceAuthenticator => ({
    SecurityLevel: { NONE: 0 },
    getEnrolledLevelAsync: jest.fn(async () => {
      if (over.throwOnLevel) throw new Error('no keystore');
      return over.level ?? 1;
    }),
    authenticateAsync: jest.fn(async () => {
      if (over.throwOnAuth) throw new Error('prompt failed');
      return { success: over.success ?? true, error: over.error ?? '' };
    }),
  });

  /** `authenticateAsync` off a fake built by `auth`. */
  const prompts = (fake: DeviceAuthenticator) =>
    fake.authenticateAsync as jest.Mock;

  it('passes when the device factor answers', async () => {
    await expect(requireDeviceUnlock({ promptMessage: 'x', authenticate: auth({ level: 2 }) })).resolves.toBe(
      'unlocked',
    );
  });

  it('distinguishes a dismissed prompt from a refused one', async () => {
    await expect(
      requireDeviceUnlock({ promptMessage: 'x', authenticate: auth({ success: false, error: 'UserCancel' }) }),
    ).resolves.toBe('cancelled');
    await expect(
      requireDeviceUnlock({
        promptMessage: 'x',
        authenticate: auth({ success: false, error: 'BiometryNotMatch' }),
      }),
    ).resolves.toBe('failed');
  });

  it('refuses to reveal behind a lock with nothing on the other side', async () => {
    const fake = auth({ level: 0 });
    await expect(requireDeviceUnlock({ promptMessage: 'x', authenticate: fake })).resolves.toBe(
      'not-protected',
    );
    // A device with no enrolled factor must not even be prompted — there is
    // nothing for it to prompt with, and a silently-passed prompt is the worst
    // possible outcome for a secret reveal.
    expect(prompts(fake)).not.toHaveBeenCalled();
  });

  it('treats an unreadable or failing authenticator as a refusal', async () => {
    await expect(
      requireDeviceUnlock({ promptMessage: 'x', authenticate: auth({ throwOnLevel: true }) }),
    ).resolves.toBe('failed');
    await expect(
      requireDeviceUnlock({ promptMessage: 'x', authenticate: auth({ throwOnAuth: true }) }),
    ).resolves.toBe('failed');
  });
});

// ── Round trip: export → reinstall → import ─────────────────────────────────────

describe('the round trip (#1041 acceptance)', () => {
  it('restores the same address after a reinstall, from the revealed key alone', async () => {
    // 1. A classic wallet is created on this device.
    const created = await createTestnetWallet();

    // 2. The user passes the lock and reveals the secret.
    const outcome = await requireDeviceUnlock({
      promptMessage: 'Unlock to reveal your wallet key',
      authenticate: unlockedDevice(),
    });
    expect(outcome).toBe('unlocked');
    const revealed = await resolveSecretExport();
    if (revealed.status !== 'revealable') throw new Error('expected a revealable wallet');
    expect(revealed.address).toBe(created.address);

    // 3. The phone is lost / the app is uninstalled. `clearWalletStore` is what
    //    a fresh install starts from: no address, no key, no passkey.
    await clearWalletStore();
    expect(await getWalletAddress()).toBeNull();
    expect(await getSignerSecret()).toBeNull();
    expect((await resolveSecretExport()).status).toBe('no-wallet');

    // 4. A new device, the same app, the key typed in by hand.
    const restored = await importTestnetWallet(revealed.secret);

    // Same wallet — not a wallet that merely looks similar.
    expect(restored.address).toBe(created.address);
    const afterImport = await resolveSecretExport();
    expect(afterImport.status).toBe('revealable');
    if (afterImport.status !== 'revealable') return;
    expect(afterImport.address).toBe(created.address);
    expect(afterImport.secret).toBe(revealed.secret);
  });

  it('a revealed key typed into a device that held a smart wallet becomes that keypair wallet', async () => {
    // What a migrating user actually does: the phone already carried a passkey
    // wallet, and now they import a classic wallet over it. The passkey
    // credential left behind must not change which wallet this is, and the
    // fee-payer slot must end up holding the imported key — not the old one.
    const created = await createTestnetWallet();
    const revealed = await resolveSecretExport();
    if (revealed.status !== 'revealable') throw new Error('expected a revealable wallet');

    await clearWalletStore();
    const staleFeePayer = Keypair.random();
    await setWalletAddress(SMART_ADDRESS);
    await setSignerSecret(staleFeePayer.secret());
    await setPasskeyCredential('cred-id', 'a1b2c3');
    expect((await resolveSecretExport()).status).toBe('smart-wallet');

    const restored = await importTestnetWallet(revealed.secret);
    expect(restored.address).toBe(created.address);
    expect(await getWalletAddress()).toBe(revealed.address);
    expect(await getSignerSecret()).toBe(revealed.secret);
    expect((await resolveSecretExport()).status).toBe('revealable');

    // And the old fee-payer is gone, not merely hidden: it cannot be reached by
    // a reveal that would present it as this wallet's key.
    const final = await resolveSecretExport();
    if (final.status !== 'revealable') throw new Error('expected a revealable wallet');
    expect(final.secret).not.toBe(staleFeePayer.secret());
  });
});

// ── The scrubber and the backup path ────────────────────────────────────────────

describe('the encrypted backup still cannot carry a secret', () => {
  it('rejects secret material, with the guard left exactly as it was', () => {
    expect(() => assertNoSecretMaterial({ signerSecret: 'SABCDEFGHIJKLMNOP' })).toThrow(BackupError);
    expect(() =>
      assertNoSecretMaterial({ settings: { device: { privateKey: 'x' } } }),
    ).toThrow(/privateKey/);
    // Public state is still fine — the guard is about keys, not about wallets.
    expect(() => assertNoSecretMaterial({ address: SMART_ADDRESS, signers: [] })).not.toThrow();
  });

  it('a revealed keypair wallet exports a backup with no key in it', async () => {
    const created = await createTestnetWallet();
    const revealed = await resolveSecretExport();
    if (revealed.status !== 'revealable') throw new Error('expected a revealable wallet');

    // The real metadata the backup screen collects for this wallet.
    const metadata = await collectWalletMetadata({
      address: created.address,
      signers: [{ index: 0, publicKey: created.address }],
    });
    expect(JSON.stringify(metadata)).not.toContain(revealed.secret);

    // And the envelope it produces is not one step away from leaking it:
    // adding the key the way a careless export would is refused outright.
    // (Low iteration count, as in `backup.test.ts` — the point here is the
    // scrubber, not the work factor, and 600k PBKDF2 rounds on the JS thread
    // would cost the suite half a minute.)
    const TEST_ITERATIONS = 1_000;
    expect(() =>
      encryptBackup(
        { ...metadata, secret: revealed.secret } as never,
        'a-passphrase-that-is-long',
        { iterations: TEST_ITERATIONS },
      ),
    ).toThrow(BackupError);

    const sealed = encryptBackup(metadata, 'a-passphrase-that-is-long', {
      iterations: TEST_ITERATIONS,
    });
    expect(JSON.stringify(sealed)).not.toContain(revealed.secret);
  });

  it('revealing writes nothing anywhere but the keychain it read from', async () => {
    await createTestnetWallet();
    const revealed = await resolveSecretExport();
    if (revealed.status !== 'revealable') throw new Error('expected a revealable wallet');
    await requireDeviceUnlock({
      promptMessage: 'x',
      authenticate: unlockedDevice(),
    });
    await resolveSecretExport();

    // The secret exists in exactly one place: the secure-store slot.
    expect(mockStore.get(SecureKey.signerSecret)).toBe(revealed.secret);

    const keys = await AsyncStorage.getAllKeys();
    const dumped = await AsyncStorage.multiGet(keys);
    for (const [key, value] of dumped) {
      expect(value ?? '').not.toContain(revealed.secret);
      // No reveal-specific cache: nothing to expire, nothing to leak, nothing
      // for a reset to forget.
      expect(key.toLowerCase()).not.toMatch(/secret|private|reveal/);
    }
  });
});
