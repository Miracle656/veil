/**
 * Privacy key derivation (lib/privacy/keys.ts) — #711.
 *
 * The golden vector below is SHARED with the web wallet's
 * `frontend/wallet/lib/privacy/__tests__/keys.test.ts`. It pins the whole
 * convention — SEP-53 payload, SHA-256 digest, raw 64-byte Ed25519 signature,
 * and SPP's two `SHA-256(domain || signature)` key seeds — from a fixed
 * 32-byte PRF output. Both suites asserting the same hexes is what proves
 * "same passkey → same privacy keys on web and mobile": upstream SPP then
 * materialises the BN254 note key and X25519 encryption key from these exact
 * seeds, identically on both platforms.
 */

import { Keypair, hash } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

import { evaluatePrf } from '../../passkey';
import { getPasskeyId, getSignerSecret } from '../../walletStore';
import {
  KEY_DERIVATION_MESSAGE,
  NO_PRF_PASSKEY_MESSAGE,
  SEP53_MESSAGE_PREFIX,
  derivePrivacyKeySeeds,
  isPrivacyRecoverySupported,
  keyDerivationPayload,
  preparePrivacySigner,
  signPrivacyKeyDerivation,
} from '../keys';

jest.mock('../../passkey', () => ({ evaluatePrf: jest.fn() }));
jest.mock('../../walletStore', () => ({
  getPasskeyId: jest.fn(),
  getSignerSecret: jest.fn(),
}));

const mockEvaluatePrf = evaluatePrf as jest.MockedFunction<typeof evaluatePrf>;
const mockGetPasskeyId = getPasskeyId as jest.MockedFunction<typeof getPasskeyId>;
const mockGetSignerSecret = getSignerSecret as jest.MockedFunction<typeof getSignerSecret>;

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function fromHex(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'hex'));
}

// The fixed PRF output both suites feed their spend-key derivation — i.e. the
// bytes a real passkey's PRF would return under the fee-payer salt.
const PRF_OUTPUT = '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dc';
const PASSKEY_ID = 'AQIDBAUGBwgJCgsMDQ4PEA';

// Golden values computed against the convention in encryption.rs upstream
// (NethermindEth/stellar-private-payments). Regenerating them is a bug.
const GOLDEN_ADDRESS = 'GB2VYTFZEVWKPTOEVT64NT7O3KCJAF7FXH4VCTUZDEN5M7QLBVBHNSPM';
const GOLDEN_DIGEST = '1bd9450dd9c1e416ce63515b16c44107669d94f7240c9390c74b4f4e04a4b9d9';
const GOLDEN_SIGNATURE =
  '0f2e9c92ed62c4916cc5a304efa295629af1d28d72a8a9e684713ee51e736cce' +
  '0df02e47da4daf956f9eb7d1380c70e8e0ca3cab1f7a7c65ab049537aea2f60c';
const GOLDEN_NOTE_SEED = '40b92dbcaeb7c32d788494b142c96efb2d2beae8a3aae38e36f8835208731afb';
const GOLDEN_ENCRYPTION_SEED = '56e862ebb5f87cc57b2cba94407b8d7924b6459f890a83d6cf6f2e40449db2ea';

const prfOk = () => mockEvaluatePrf.mockResolvedValue({ output: fromHex(PRF_OUTPUT), outcome: 'ok' });
const prfUnsupported = () => mockEvaluatePrf.mockResolvedValue({ output: null, outcome: 'unsupported' });
const prfCancelled = () => mockEvaluatePrf.mockResolvedValue({ output: null, outcome: 'cancelled' });

/** The stored signer of a keypair-mode wallet for this vector. */
function keypairSecret(): string {
  return Keypair.fromRawEd25519Seed(Buffer.from(PRF_OUTPUT, 'hex')).secret();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPasskeyId.mockResolvedValue(null);
  mockGetSignerSecret.mockResolvedValue(null);
});

describe('SPP key-derivation convention', () => {
  it('signs the SEP-53 payload for the fixed message', () => {
    expect(KEY_DERIVATION_MESSAGE).toBe('Privacy Pool Key Derivation [v1]');
    expect(Buffer.from(keyDerivationPayload()).toString('utf8')).toBe(
      SEP53_MESSAGE_PREFIX + KEY_DERIVATION_MESSAGE,
    );
    // stellar-base `hash` is SHA-256; the digest is the golden vector's.
    expect(hex(hash(Buffer.from(keyDerivationPayload())))).toBe(GOLDEN_DIGEST);
  });

  it('derives SPP note / encryption seeds from the raw signature', () => {
    const seeds = derivePrivacyKeySeeds(fromHex(GOLDEN_SIGNATURE));
    expect(hex(seeds.noteSeed)).toBe(GOLDEN_NOTE_SEED);
    expect(hex(seeds.encryptionSeed)).toBe(GOLDEN_ENCRYPTION_SEED);
  });

  it('rejects a signature that is not the 64 bytes upstream demands', () => {
    expect(() => derivePrivacyKeySeeds(new Uint8Array(63))).toThrow(/64-byte/);
  });
});

describe('signPrivacyKeyDerivation', () => {
  it('turns the PRF-derived spend key into the golden signature and seeds', () => {
    const kp = Keypair.fromRawEd25519Seed(Buffer.from(PRF_OUTPUT, 'hex'));
    const result = signPrivacyKeyDerivation(kp);
    expect(result.ownerAddress).toBe(GOLDEN_ADDRESS);
    expect(hex(result.signature)).toBe(GOLDEN_SIGNATURE);
    expect(hex(result.noteSeed)).toBe(GOLDEN_NOTE_SEED);
    expect(hex(result.encryptionSeed)).toBe(GOLDEN_ENCRYPTION_SEED);
    expect(result.recoverySupported).toBe(true);
    // The signature must verify under the owner address — SPP's own check.
    expect(kp.verify(hash(Buffer.from(keyDerivationPayload())), Buffer.from(result.signature))).toBe(true);
  });
});

describe('preparePrivacySigner — passkey wallet', () => {
  it('derives the spend key via the PRF ceremony and marks recovery supported', async () => {
    prfOk();
    mockGetPasskeyId.mockResolvedValue(PASSKEY_ID);
    mockGetSignerSecret.mockResolvedValue(Keypair.fromRawEd25519Seed(Buffer.from(PRF_OUTPUT, 'hex')).secret());

    const result = await preparePrivacySigner();

    expect(result.ownerAddress).toBe(GOLDEN_ADDRESS);
    expect(hex(result.signature)).toBe(GOLDEN_SIGNATURE);
    expect(hex(result.noteSeed)).toBe(GOLDEN_NOTE_SEED);
    expect(result.recoverySupported).toBe(true);
    expect(mockEvaluatePrf).toHaveBeenCalledTimes(1);
  });

  it('re-deriving on a fresh device produces identical privacy keys', async () => {
    prfOk();
    mockGetPasskeyId.mockResolvedValue(PASSKEY_ID);

    // A new device has no stored secret — the passkey ceremony alone is enough.
    const onNewDevice = await preparePrivacySigner();
    const onOriginalDevice = signPrivacyKeyDerivation(
      Keypair.fromRawEd25519Seed(Buffer.from(PRF_OUTPUT, 'hex')),
    );
    expect(onNewDevice.ownerAddress).toBe(onOriginalDevice.ownerAddress);
    expect(hex(onNewDevice.noteSeed)).toBe(hex(onOriginalDevice.noteSeed));
    expect(hex(onNewDevice.encryptionSeed)).toBe(hex(onOriginalDevice.encryptionSeed));
  });

  it('refuses a PRF-less passkey with the explicit recovery warning', async () => {
    prfUnsupported();
    mockGetPasskeyId.mockResolvedValue(PASSKEY_ID);

    await expect(preparePrivacySigner()).rejects.toThrow(NO_PRF_PASSKEY_MESSAGE);
    expect(NO_PRF_PASSKEY_MESSAGE).toMatch(/PRF/);
    expect(NO_PRF_PASSKEY_MESSAGE).toMatch(/another device/);
    expect(NO_PRF_PASSKEY_MESSAGE).toMatch(/recoverable only on this/i);
  });

  it('surfaces a cancelled ceremony as a retryable error, not a warning', async () => {
    prfCancelled();
    mockGetPasskeyId.mockResolvedValue(PASSKEY_ID);

    await expect(preparePrivacySigner()).rejects.toThrow(/cancelled/i);
  });

  it('rejects a ceremony key that does not control the requested account', async () => {
    prfOk();
    mockGetPasskeyId.mockResolvedValue(PASSKEY_ID);

    await expect(preparePrivacySigner('GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCVL'))
      .rejects.toThrow(/does not control/);
  });
});

describe('preparePrivacySigner — keypair wallet', () => {
  it('signs with the stored key and reports recovery as unsupported', async () => {
    mockGetSignerSecret.mockResolvedValue(keypairSecret());

    const result = await preparePrivacySigner();

    expect(result.ownerAddress).toBe(GOLDEN_ADDRESS);
    expect(hex(result.signature)).toBe(GOLDEN_SIGNATURE);
    expect(result.recoverySupported).toBe(false);
    // Signing from the stored key must not prompt for a passkey.
    expect(mockEvaluatePrf).not.toHaveBeenCalled();
  });

  it('throws when this device holds no wallet at all', async () => {
    await expect(preparePrivacySigner()).rejects.toThrow(/no wallet/i);
  });
});

describe('isPrivacyRecoverySupported', () => {
  it('is true when the stored signer is the passkey-derived key', async () => {
    prfOk();
    mockGetPasskeyId.mockResolvedValue(PASSKEY_ID);
    mockGetSignerSecret.mockResolvedValue(Keypair.fromRawEd25519Seed(Buffer.from(PRF_OUTPUT, 'hex')).secret());

    await expect(isPrivacyRecoverySupported()).resolves.toBe(true);
  });

  it('is false for a passkey whose PRF never answers (e.g. Samsung Pass)', async () => {
    prfUnsupported();
    mockGetPasskeyId.mockResolvedValue(PASSKEY_ID);
    mockGetSignerSecret.mockResolvedValue(Keypair.random().secret());

    await expect(isPrivacyRecoverySupported()).resolves.toBe(false);
  });

  it('is false when a stored signer drifted from the passkey-derived key', async () => {
    prfOk();
    mockGetPasskeyId.mockResolvedValue(PASSKEY_ID);
    mockGetSignerSecret.mockResolvedValue(Keypair.random().secret());

    await expect(isPrivacyRecoverySupported()).resolves.toBe(false);
  });

  it('is false for a keypair-mode wallet with no passkey', async () => {
    mockGetSignerSecret.mockResolvedValue(keypairSecret());
    await expect(isPrivacyRecoverySupported()).resolves.toBe(false);
  });

  it('answers "no" rather than throwing when the store itself fails', async () => {
    mockGetPasskeyId.mockRejectedValue(new Error('keychain unavailable'));
    mockGetSignerSecret.mockRejectedValue(new Error('keychain unavailable'));

    await expect(isPrivacyRecoverySupported()).resolves.toBe(false);
  });
});
