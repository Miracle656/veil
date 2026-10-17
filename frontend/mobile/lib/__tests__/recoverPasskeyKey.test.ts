/**
 * Recovering a wallet's passkey public key from a signature.
 *
 * These wallets exist on mainnet: real money at an address whose public key was
 * never recorded, so `deploy()` refused and the money could not move. The point
 * of the recovery is that it needs nothing but the passkey — no backup, no
 * breadcrumbs, no server — and that it still refuses when the signature belongs
 * to a different wallet, since accepting there would deploy an empty contract.
 */

import { p256 } from '@noble/curves/p256.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Buffer } from 'buffer';
import { computeWalletAddress } from '@veil/sdk';

import { assertForKeyRecovery } from '../passkey';
import { getNetwork } from '../network';
import { fetchContractXlm } from '../activity';
import { isWalletDeployed } from '../contractSpend';
import {
  recoverPublicKeyCandidates,
  recoverWalletFromAssertion,
  recoverWalletPublicKey,
} from '../recoverPasskeyKey';
import { setPasskeyCredential } from '../walletStore';
import { writeBreadcrumbs } from '../walletBreadcrumbs';

jest.mock('../passkey', () => ({ assertForKeyRecovery: jest.fn() }));
jest.mock('../network', () => ({ getNetwork: jest.fn(), getNetworkName: jest.fn(() => 'mainnet') }));
jest.mock('../activity', () => ({
  getFeePayerAddress: jest.fn(async () => 'G' + 'A'.repeat(55)),
  fetchContractXlm: jest.fn(async () => 0),
}));
jest.mock('../contractSpend', () => ({ isWalletDeployed: jest.fn(async () => false) }));
jest.mock('../walletBreadcrumbs', () => ({ writeBreadcrumbs: jest.fn(async () => true) }));
jest.mock('../walletStore', () => ({
  getPasskeyId: jest.fn(async () => 'credential-id'),
  setPasskeyCredential: jest.fn(async () => undefined),
  getSignerSecret: jest.fn(async () => 'S' + 'A'.repeat(55)),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({ multiSet: jest.fn(async () => undefined) }));

const mockAssert = assertForKeyRecovery as jest.MockedFunction<typeof assertForKeyRecovery>;
const mockNetwork = getNetwork as jest.MockedFunction<typeof getNetwork>;

const FACTORY = 'CCZ3JLRESNLDADGXWNEH4YQ4NXUUAHRJNCWZHYG6QB4KTDYHOH6OQ7BK';
const PASSPHRASE = 'Public Global Stellar Network ; September 2015';

/**
 * A real assertion: a real P-256 key signing the real WebAuthn preimage.
 *
 * `challenge` varies because noble signs deterministically (RFC 6979), and so
 * do some authenticators — two assertions differ only because the challenge and
 * the authenticator's signature counter do. That difference is exactly what the
 * second-signature tie-break relies on.
 */
function sign(privateKey: Uint8Array, challenge = 'abc') {
  const authData = new Uint8Array(37).fill(9);
  const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge }));
  const clientDataHash = sha256(clientDataJSON);
  const signed = new Uint8Array(authData.length + clientDataHash.length);
  signed.set(authData, 0);
  signed.set(clientDataHash, authData.length);
  // Low-S normalised and raw, exactly as `derToRawSignature` hands it over.
  const signature = p256.sign(sha256(signed), privateKey).normalizeS().toCompactRawBytes();
  return { credentialId: 'credential-id', signature, authData, clientDataJSON };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockNetwork.mockReturnValue({
    factoryContractId: FACTORY,
    networkPassphrase: PASSPHRASE,
  } as ReturnType<typeof getNetwork>);
});

describe('recoverPublicKeyCandidates', () => {
  it('includes the key that actually signed', () => {
    for (let i = 0; i < 25; i++) {
      const priv = p256.utils.randomPrivateKey();
      const pub = Buffer.from(p256.getPublicKey(priv, false)).toString('hex');
      const candidates = recoverPublicKeyCandidates(sign(priv)).map((c) => Buffer.from(c).toString('hex'));
      expect(candidates).toContain(pub);
    }
  });

  it('returns nothing for a signature that is not 64 bytes', () => {
    const priv = p256.utils.randomPrivateKey();
    expect(recoverPublicKeyCandidates({ ...sign(priv), signature: new Uint8Array(10) })).toEqual([]);
  });
});

describe('recoverWalletPublicKey', () => {
  it('recovers the key for the wallet, and records it so the prompt is not needed again', async () => {
    const priv = p256.utils.randomPrivateKey();
    const pub = p256.getPublicKey(priv, false);
    const address = computeWalletAddress(FACTORY, pub, PASSPHRASE);
    mockAssert.mockResolvedValue(sign(priv));

    const recovered = await recoverWalletPublicKey(address);

    expect(recovered).not.toBeNull();
    expect(Buffer.from(recovered as Uint8Array).toString('hex')).toBe(Buffer.from(pub).toString('hex'));
    expect(setPasskeyCredential).toHaveBeenCalledWith('credential-id', Buffer.from(pub).toString('hex'));
    expect(writeBreadcrumbs).toHaveBeenCalledWith(expect.any(String), address, recovered);
  });

  it('refuses a passkey that belongs to a different wallet, and records nothing', async () => {
    const mine = p256.getPublicKey(p256.utils.randomPrivateKey(), false);
    const address = computeWalletAddress(FACTORY, mine, PASSPHRASE);
    mockAssert.mockResolvedValue(sign(p256.utils.randomPrivateKey()));

    expect(await recoverWalletPublicKey(address)).toBeNull();
    expect(setPasskeyCredential).not.toHaveBeenCalled();
    expect(writeBreadcrumbs).not.toHaveBeenCalled();
  });

  it('returns null when the prompt is dismissed', async () => {
    mockAssert.mockResolvedValue(null);
    expect(await recoverWalletPublicKey('C' + 'A'.repeat(55))).toBeNull();
    expect(setPasskeyCredential).not.toHaveBeenCalled();
  });
});

/**
 * Signing in on a new phone with nothing but the passkey.
 *
 * This is the claim the product makes — no seed phrase, no backup file — and
 * until now it quietly depended on two things written at creation: a PRF output
 * and the on-chain breadcrumbs. A wallet created when either failed could not be
 * signed into anywhere else. The address is a pure function of the passkey's
 * public key, so the assertion alone is in fact enough.
 */
describe('recoverWalletFromAssertion', () => {
  const mockDeployed = isWalletDeployed as jest.MockedFunction<typeof isWalletDeployed>;
  const mockBalance = fetchContractXlm as jest.MockedFunction<typeof fetchContractXlm>;

  beforeEach(() => {
    mockDeployed.mockResolvedValue(false);
    mockBalance.mockResolvedValue(0);
  });

  it('picks the candidate whose wallet is deployed', async () => {
    const priv = p256.utils.randomPrivateKey();
    const real = computeWalletAddress(FACTORY, p256.getPublicKey(priv, false), PASSPHRASE);
    mockDeployed.mockImplementation(async (address: string) => address === real);

    expect(await recoverWalletFromAssertion(sign(priv))).toMatchObject({ address: real });
  });

  // An undeployed wallet is exactly the case that strands money: it holds a
  // balance at an address no contract exists at yet.
  it('picks the candidate holding a balance even though nothing is deployed', async () => {
    const priv = p256.utils.randomPrivateKey();
    const real = computeWalletAddress(FACTORY, p256.getPublicKey(priv, false), PASSPHRASE);
    mockBalance.mockImplementation(async (address: string) => (address === real ? 5 : 0));

    expect(await recoverWalletFromAssertion(sign(priv))).toMatchObject({ address: real });
  });

  // Every candidate verifies the signature, so a second one is what separates
  // them: the true key is in both sets, the false ones are not.
  it('asks for a second signature when the wallet is empty and undeployed', async () => {
    const priv = p256.utils.randomPrivateKey();
    const real = computeWalletAddress(FACTORY, p256.getPublicKey(priv, false), PASSPHRASE);
    mockAssert.mockResolvedValue(sign(priv, 'second-challenge'));

    const resolved = await recoverWalletFromAssertion(sign(priv, 'first-challenge'));

    expect(mockAssert).toHaveBeenCalledWith('credential-id');
    expect(resolved).toMatchObject({ address: real });
  });

  it('refuses rather than guessing when the second signature is declined', async () => {
    mockAssert.mockResolvedValue(null);
    expect(await recoverWalletFromAssertion(sign(p256.utils.randomPrivateKey()))).toBeNull();
  });
});
