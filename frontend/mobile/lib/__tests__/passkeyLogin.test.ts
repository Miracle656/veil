/**
 * Address-led sign-in: prove possession of a registered passkey against the
 * wallet's on-chain signer set, with no PRF required.
 *
 * The acceptance criteria the suite pins down:
 *  1. A valid address whose signer set contains the user's passkey signs in
 *     with no PRF anywhere in the path.
 *  2. "No wallet at this address" and "network unreachable" read differently.
 *  3. A passkey that is not in the signer set is refused, and no wallet state
 *     is written.
 *  4. Malformed input is rejected before any network call.
 */

const mockReadSigners = jest.fn();
const mockDiscoverWithPrf = jest.fn();
const mockSetWalletAddress = jest.fn();
const mockSetSignerSecret = jest.fn();
const mockSetPasskeyCredential = jest.fn();
const mockWriteBreadcrumbs = jest.fn();
const mockMultiSet = jest.fn();
const mockGetNetworkName = jest.fn();

jest.mock('../signers', () => {
  const actual = jest.requireActual('../signers');
  return { ...actual, readSigners: (...a: unknown[]) => mockReadSigners(...a) };
});
jest.mock('../passkey', () => ({
  discoverWithPrf: (...a: unknown[]) => mockDiscoverWithPrf(...a),
  nativePrfEvaluator: jest.fn(),
}));
jest.mock('../walletStore', () => ({
  getSignerSecret: jest.fn(async () => null),
  getWalletAddress: jest.fn(async () => null),
  setPasskeyCredential: (...a: unknown[]) => mockSetPasskeyCredential(...a),
  setPasskeyId: jest.fn(async () => undefined),
  setSignerSecret: (...a: unknown[]) => mockSetSignerSecret(...a),
  setWalletAddress: (...a: unknown[]) => mockSetWalletAddress(...a),
}));
jest.mock('../walletBreadcrumbs', () => ({
  readBreadcrumbs: jest.fn(),
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

import { loginWithAddress } from '../passkeyLogin';
import { WalletContractNotFoundError } from '../signers';
import type { DiscoveredPasskey } from '../passkey';

/** A valid C-address for the tests. */
const WALLET = StrKey.encodeContract(Buffer.alloc(32, 7));
/** The passkey the wallet was created with (signer #0's private key). */
const REGISTERED = new Uint8Array(32).fill(7);
/** A different, unrelated passkey that never signed up for this wallet. */
const INTRUDER = new Uint8Array(32).fill(9);
/** The SDK's storage keys, market-testnet base names (no `_mainnet` suffix). */
const SDK_KEYS = {
  ADDRESS: 'invisible_wallet_address',
  KEY_ID: 'invisible_wallet_key_id',
  PUBLIC_KEY: 'invisible_wallet_public_key',
};

function signerOf(privateKey: Uint8Array): { index: number; publicKey: string } {
  return {
    index: 0,
    publicKey: Buffer.from(p256.getPublicKey(privateKey, false)).toString('hex'),
  };
}

/**
 * A WebAuthn assertion the way the app sees it: raw 64-byte signature over
 * SHA-256(authData ‖ SHA-256(clientDataJSON)), exactly what
 * `findMatchingSigner` will re-verify.
 */
function assertionOf(privateKey: Uint8Array, prf: Uint8Array | null = null): DiscoveredPasskey {
  const authData = new Uint8Array(37);
  authData.set(sha256(new TextEncoder().encode('app.useveilapp.xyz')), 0);
  authData[32] = 0x05; // UP | UV
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

beforeEach(() => {
  jest.resetAllMocks();
  mockGetNetworkName.mockReturnValue('testnet');
  mockMultiSet.mockResolvedValue(undefined);
  mockWriteBreadcrumbs.mockResolvedValue(undefined);
});

describe('loginWithAddress — acceptance criteria', () => {
  it('signs in with no PRF when the address and passkey match', async () => {
    mockReadSigners.mockResolvedValue([signerOf(REGISTERED)]);
    mockDiscoverWithPrf.mockResolvedValue(assertionOf(REGISTERED));

    const result = await loginWithAddress(WALLET);

    expect(result).toEqual({ address: WALLET, recoverable: false });
    expect(mockSetWalletAddress).toHaveBeenCalledWith(WALLET);
    expect(mockSetPasskeyCredential).toHaveBeenCalledWith('test-credential', signerOf(REGISTERED).publicKey);
    const secret = mockSetSignerSecret.mock.calls[0][0];
    expect(() => Keypair.fromSecret(secret)).not.toThrow();
    expect(mockWriteBreadcrumbs).toHaveBeenCalledWith(secret, WALLET, expect.any(Uint8Array));
    expect(mockMultiSet).toHaveBeenCalledWith([
      [SDK_KEYS.ADDRESS, WALLET],
      [SDK_KEYS.KEY_ID, 'test-credential'],
      [SDK_KEYS.PUBLIC_KEY, signerOf(REGISTERED).publicKey],
    ]);
    // The passkey still had to be held — but a null PRF must not block it.
    expect(mockDiscoverWithPrf.mock.calls[0][0]).toBeInstanceOf(Uint8Array);
  });

  it('derives the fee-payer from the passkey PRF when the passkey offers it', async () => {
    const prfSeed = new Uint8Array(32).fill(11);
    mockReadSigners.mockResolvedValue([signerOf(REGISTERED)]);
    mockDiscoverWithPrf.mockResolvedValue(assertionOf(REGISTERED, prfSeed));

    const result = await loginWithAddress(WALLET);

    expect(result.recoverable).toBe(true);
    expect(mockSetSignerSecret).toHaveBeenCalledWith(
      Keypair.fromRawEd25519Seed(Buffer.from(prfSeed)).secret(),
    );
  });

  it('reports an undeployed address distinctly from a network failure', async () => {
    mockReadSigners.mockRejectedValue(new WalletContractNotFoundError(WALLET));

    await expect(loginWithAddress(WALLET)).rejects.toThrow(/No deployed wallet/);
    expect(mockDiscoverWithPrf).not.toHaveBeenCalled();
    expect(mockSetWalletAddress).not.toHaveBeenCalled();
  });

  it('reports an unreachable network distinctly from a missing wallet', async () => {
    mockReadSigners.mockRejectedValue(new Error('Failed to fetch'));

    await expect(loginWithAddress(WALLET)).rejects.toThrow(/Could not reach the network/);
    expect(mockDiscoverWithPrf).not.toHaveBeenCalled();
    expect(mockSetWalletAddress).not.toHaveBeenCalled();
  });

  it('refuses a passkey that is not in the signer set and writes no wallet state', async () => {
    mockReadSigners.mockResolvedValue([signerOf(REGISTERED)]);
    mockDiscoverWithPrf.mockResolvedValue(assertionOf(INTRUDER));

    await expect(loginWithAddress(WALLET)).rejects.toThrow(/not a signer/);
    expect(mockSetWalletAddress).not.toHaveBeenCalled();
    expect(mockSetSignerSecret).not.toHaveBeenCalled();
    expect(mockSetPasskeyCredential).not.toHaveBeenCalled();
    expect(mockWriteBreadcrumbs).not.toHaveBeenCalled();
    expect(mockMultiSet).not.toHaveBeenCalled();
  });

  it('rejects malformed input before any network call', async () => {
    mockReadSigners.mockResolvedValue([signerOf(REGISTERED)]);

    await expect(loginWithAddress('not-an-address')).rejects.toThrow(/not a wallet address/);
    await expect(loginWithAddress('')).rejects.toThrow(/not a wallet address/);
    await expect(loginWithAddress('   ')).rejects.toThrow(/not a wallet address/);
    await expect(loginWithAddress('G5KFY2U35PGLDYMYY5HW7XOLHP7UMM6XKBQJ3HVJ7EO3M3XCVSYVAQCE')).rejects.toThrow(
      /not a wallet address/,
    );
    expect(mockReadSigners).not.toHaveBeenCalled();
    expect(mockDiscoverWithPrf).not.toHaveBeenCalled();
    expect(mockSetWalletAddress).not.toHaveBeenCalled();
  });
});

describe('loginWithAddress — edge cases', () => {
  it('finds the passkey even when it is not the first signer', async () => {
    const other = signerOf(INTRUDER);
    const ours = signerOf(REGISTERED);
    mockReadSigners.mockResolvedValue([
      { index: 0, publicKey: other.publicKey },
      { index: 1, publicKey: ours.publicKey },
    ]);
    mockDiscoverWithPrf.mockResolvedValue(assertionOf(REGISTERED));

    const result = await loginWithAddress(WALLET);

    expect(result.address).toBe(WALLET);
    expect(mockSetPasskeyCredential).toHaveBeenCalledWith('test-credential', ours.publicKey);
  });

  it('trims surrounding whitespace around a valid address', async () => {
    mockReadSigners.mockResolvedValue([signerOf(REGISTERED)]);
    mockDiscoverWithPrf.mockResolvedValue(assertionOf(REGISTERED));

    const result = await loginWithAddress(`  ${WALLET}\n`);

    expect(result.address).toBe(WALLET);
    expect(mockReadSigners).toHaveBeenCalledWith(WALLET);
  });

  it('reports a cancelled passkey prompt and writes nothing', async () => {
    mockReadSigners.mockResolvedValue([signerOf(REGISTERED)]);
    mockDiscoverWithPrf.mockResolvedValue(null);

    await expect(loginWithAddress(WALLET)).rejects.toThrow(/cancelled/);
    expect(mockSetWalletAddress).not.toHaveBeenCalled();
    expect(mockSetSignerSecret).not.toHaveBeenCalled();
  });
});