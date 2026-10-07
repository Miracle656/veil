/**
 * Tests for lib/passkeyWallet.ts — the mobile fee-payer derivation at wallet
 * creation (ADR 0003 / issue #682).
 *
 * The acceptance criteria this suite pins down:
 *  1. The fee-payer is derived from the passkey's WebAuthn PRF output, not
 *     the (public) credential id — the executable form of "C2 is fixed".
 *  2. Web and mobile derive the SAME address for the same PRF output — the
 *     'prf-raw' fixture is pinned identically in
 *     frontend/wallet/lib/__tests__/feePayer.test.ts ("GOLDEN_FEE_PAYER_ADDRESS").
 *     A mismatch here would mean a wallet's fee payer differs per device and
 *     funds land somewhere the user cannot spend from.
 *  3. When PRF is unavailable, the wallet is created anyway with an explicit,
 *     surfaced `recoverable: false` — never a silent fallback to the legacy
 *     credential-id derivation (which would quietly reintroduce C2).
 */

const mockEvaluatePrf = jest.fn();
const mockFundWithFriendbot = jest.fn();
const mockWriteBreadcrumbs = jest.fn();
const mockSetWalletAddress = jest.fn();
const mockSetSignerSecret = jest.fn();
const mockSetPasskeyCredential = jest.fn();
const mockSetPasskeyId = jest.fn();
const mockGetItem = jest.fn();

jest.mock('../passkey', () => ({
  evaluatePrf: (...a: unknown[]) => mockEvaluatePrf(...a),
}));
jest.mock('../testnetWallet', () => ({
  fundWithFriendbot: (...a: unknown[]) => mockFundWithFriendbot(...a),
}));
jest.mock('../walletBreadcrumbs', () => ({
  writeBreadcrumbs: (...a: unknown[]) => mockWriteBreadcrumbs(...a),
}));
jest.mock('../walletStore', () => ({
  getPasskeyPublicKey: jest.fn(async () => null),
  getSignerSecret: jest.fn(async () => null),
  getWalletAddress: jest.fn(async () => null),
  setPasskeyCredential: (...a: unknown[]) => mockSetPasskeyCredential(...a),
  setPasskeyId: (...a: unknown[]) => mockSetPasskeyId(...a),
  setSignerSecret: (...a: unknown[]) => mockSetSignerSecret(...a),
  setWalletAddress: (...a: unknown[]) => mockSetWalletAddress(...a),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: (...a: unknown[]) => mockGetItem(...a) },
}));

import { Keypair } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

import { createPasskeyWallet, type PasskeyWalletResult } from '../passkeyWallet';
import type { CreatedWallet } from '../testnetWallet';
import { deriveFeePayerKeypair } from '../deriveFeePayer';

const CREDENTIAL_ID = 'QUJDRA'; // base64url, arbitrary but valid
const WALLET_ADDRESS = 'CD3LA6RKF5D2FN2R2L57MWXLBRSEWWENE74YBEFZSSGNJRJGICFGQXMX';

function registerable(walletAddress = WALLET_ADDRESS, publicKeyBytes = new Uint8Array(65).fill(4)) {
  return { register: jest.fn(async () => ({ walletAddress, publicKeyBytes })) };
}

beforeEach(() => {
  jest.resetAllMocks();
  mockGetItem.mockResolvedValue(CREDENTIAL_ID);
  mockFundWithFriendbot.mockResolvedValue(true);
  mockWriteBreadcrumbs.mockResolvedValue(undefined);
});

/**
 * The wallet behind a `createPasskeyWallet` result.
 *
 * It returns a union now: `{ status: 'created', wallet }` when PRF produced a
 * fee payer, or `{ status: 'unsupported', commit }` when it did not and the
 * storage write is deferred until the user has seen the answer (#767). These
 * assertions are about the wallet either way, so commit the deferred one.
 */
async function walletFrom(result: PasskeyWalletResult): Promise<CreatedWallet> {
  return result.status === 'created' ? result.wallet : result.commit();
}

describe('createPasskeyWallet — PRF-derived fee payer (secure path)', () => {
  it('derives the fee payer from the PRF output, not the credential id (C2)', async () => {
    const prfOutput = new Uint8Array(32).fill(11);
    mockEvaluatePrf.mockResolvedValue({ outcome: 'ok', output: prfOutput });

    const result = await walletFrom(await createPasskeyWallet(registerable()));

    expect(result.recoverable).toBe(true);
    const expected = Keypair.fromRawEd25519Seed(Buffer.from(prfOutput)).publicKey();
    const storedSecret = mockSetSignerSecret.mock.calls[0][0];
    expect(Keypair.fromSecret(storedSecret).publicKey()).toBe(expected);

    // C2, stated as an executable check: the credential id ALONE (with no PRF)
    // must not be sufficient to reconstruct this fee payer.
    const legacy = await deriveFeePayerKeypair(CREDENTIAL_ID);
    expect(Keypair.fromSecret(storedSecret).publicKey()).not.toBe(legacy.publicKey());
  });

  it('agrees with the web wallet on the fee-payer address for the same PRF output', async () => {
    // Same fixture as frontend/wallet/lib/__tests__/feePayer.test.ts's
    // "cross-platform key agreement" test — both derive the seed as the raw
    // PRF output (no HKDF), so they must land on the same G-address.
    const GOLDEN_PRF_OUTPUT = new Uint8Array(32).fill(7);
    const GOLDEN_FEE_PAYER_ADDRESS = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';
    mockEvaluatePrf.mockResolvedValue({ outcome: 'ok', output: GOLDEN_PRF_OUTPUT });

    await createPasskeyWallet(registerable());

    const storedSecret = mockSetSignerSecret.mock.calls[0][0];
    expect(Keypair.fromSecret(storedSecret).publicKey()).toBe(GOLDEN_FEE_PAYER_ADDRESS);
  });

  it('persists the passkey credential and wallet address alongside the fee payer', async () => {
    const publicKeyBytes = new Uint8Array(65).fill(4);
    mockEvaluatePrf.mockResolvedValue({ outcome: 'ok', output: new Uint8Array(32).fill(3) });

    await createPasskeyWallet(registerable(WALLET_ADDRESS, publicKeyBytes));

    expect(mockSetWalletAddress).toHaveBeenCalledWith(WALLET_ADDRESS);
    expect(mockSetPasskeyCredential).toHaveBeenCalledWith(
      CREDENTIAL_ID,
      Buffer.from(publicKeyBytes).toString('hex'),
    );
  });
});

describe('createPasskeyWallet — PRF unavailable (explicit degrade, not a silent legacy fallback)', () => {
  it('creates the wallet with a random, unrecoverable key and surfaces recoverable: false', async () => {
    mockEvaluatePrf.mockResolvedValue({ outcome: 'unsupported', output: null });

    const result = await walletFrom(await createPasskeyWallet(registerable()));

    expect(result.recoverable).toBe(false);
    expect(result.recoveryIssue).toBe('unsupported');

    // The fallback must be a fresh random key — specifically NOT the legacy
    // HKDF(credentialId) derivation, which would silently reintroduce C2.
    const legacy = await deriveFeePayerKeypair(CREDENTIAL_ID);
    const storedSecret = mockSetSignerSecret.mock.calls[0][0];
    expect(Keypair.fromSecret(storedSecret).publicKey()).not.toBe(legacy.publicKey());
  });

  it('does not retry PRF a second time once the authenticator reports it unsupported', async () => {
    mockEvaluatePrf.mockResolvedValue({ outcome: 'unsupported', output: null });

    await createPasskeyWallet(registerable());

    expect(mockEvaluatePrf).toHaveBeenCalledTimes(1);
  });

  it('retries once on a transient failure before giving up', async () => {
    mockEvaluatePrf
      .mockResolvedValueOnce({ outcome: 'failed', output: null })
      .mockResolvedValueOnce({ outcome: 'ok', output: new Uint8Array(32).fill(5) });

    const result = await walletFrom(await createPasskeyWallet(registerable()));

    expect(mockEvaluatePrf).toHaveBeenCalledTimes(2);
    expect(result.recoverable).toBe(true);
  });
});
