/**
 * Correctness check for the native fee-payer HKDF derivation.
 *
 * Because the wallet is fee-sponsored, the derived sponsor account must be
 * byte-identical on web and native. The GOLDEN address below was derived through
 * the *web* path (WebCrypto `crypto.subtle` HKDF-SHA-256 + the same salt/info)
 * for the fixed credential id, so asserting the native (`@noble/hashes`) result
 * equals it proves the two implementations agree down to the address.
 *
 * The full cross-check that produced the golden value:
 *   const km = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
 *   const bits = await crypto.subtle.deriveBits(
 *     { name: 'HKDF', hash: 'SHA-256', salt, info }, km, 256);
 *   Keypair.fromRawEd25519Seed(Buffer.from(new Uint8Array(bits))).publicKey();
 */

import { deriveFeePayerKeypair, deriveStoredFeePayer } from '../deriveFeePayer';
import { getPasskeyId } from '../walletStore';

jest.mock('../walletStore', () => ({
  getPasskeyId: jest.fn(),
}));

const mockGetPasskeyId = getPasskeyId as jest.MockedFunction<typeof getPasskeyId>;

// Fixed test credential id and the fee-payer address the web path derives from it.
const CREDENTIAL_ID = 'AQIDBAUGBwgJCgsMDQ4PEA';
const GOLDEN_ADDRESS = 'GDNLN66V4YFQQPDVNMADJSWUF2EFSLM2BHOF2LDUGVQPQUBG7H4WRFDQ';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('deriveFeePayerKeypair', () => {
  it('derives the same G… fee-payer address as the web WebCrypto path', () => {
    const kp = deriveFeePayerKeypair(CREDENTIAL_ID);
    expect(kp.publicKey()).toBe(GOLDEN_ADDRESS);
  });

  it('is deterministic — the same credential id always yields the same account', () => {
    expect(deriveFeePayerKeypair(CREDENTIAL_ID).publicKey()).toBe(
      deriveFeePayerKeypair(CREDENTIAL_ID).publicKey(),
    );
  });

  it('produces a different account for a different credential id', () => {
    const other = deriveFeePayerKeypair('EBEBEBEBEBEBEBEBEBEBEA').publicKey();
    expect(other).not.toBe(GOLDEN_ADDRESS);
  });
});

describe('deriveStoredFeePayer', () => {
  it('derives from the credential id in secure store', async () => {
    mockGetPasskeyId.mockResolvedValue(CREDENTIAL_ID);
    const kp = await deriveStoredFeePayer();
    expect(kp?.publicKey()).toBe(GOLDEN_ADDRESS);
  });

  it('returns null when no passkey is registered', async () => {
    mockGetPasskeyId.mockResolvedValue(null);
    expect(await deriveStoredFeePayer()).toBeNull();
  });
});
