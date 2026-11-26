/**
 * The no-framework SDK must resolve a wallet from a bare assertion exactly the
 * way the React/React Native core does (issue #1044).
 *
 * `vanilla.ts` used to look for a public key on the assertion response via
 * `getPublicKey()` — a method the WebAuthn spec defines only on the *attestation*
 * response — so its `credentialId` login could never find a wallet in a real
 * browser, and the note above it recommended using the React hook "for reliable
 * cross-device login". Both entry points now recover the key from the signature
 * and verify the result on-chain. These tests run a genuine browser-shaped
 * assertion (DER signature and all) through the vanilla client with everything
 * unmocked except the Soroban server, so address derivation is the real thing.
 */

import { rpc as SorobanRpc, StrKey, Networks } from '@stellar/stellar-sdk';
import { createInvisibleWallet } from '../vanilla';
import { computeWalletAddress, derToRawSignature } from '../utils';
import { recoverAssertionPublicKeys } from '../crypto/assertionKey';

// Real SDK — address derivation must be real; only the Soroban server is faked.
jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return { ...actual, rpc: { ...actual.rpc, Server: jest.fn() } };
});

const nodeCrypto = require('crypto');

const FACTORY_ADDRESS = StrKey.encodeContract(Buffer.alloc(32));
const CONFIG = {
  factoryAddress: FACTORY_ADDRESS,
  rpcUrl: 'https://horizon-testnet.stellar.org',
  networkPassphrase: Networks.TESTNET,
};

type Assertion = { authData: Uint8Array; clientDataJSON: Uint8Array; signature: Uint8Array };

/** A real P-256 key, its public half in the SDK's 0x04 ‖ x ‖ y form. */
function makePasskey() {
  const pair = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = new Uint8Array(pair.publicKey.export({ type: 'spki', format: 'der' }));
  return { privateKey: pair.privateKey, publicKeyBytes: spki.slice(spki.length - 65) };
}

/** The raw bytes an authenticator signs, plus its DER signature. */
function makeAssertion(privateKey: unknown, seed: number): Assertion {
  const authData = new Uint8Array(37);
  authData[32] = 0x45;
  const clientDataJSON = new Uint8Array(64);
  for (let i = 0; i < clientDataJSON.length; i++) clientDataJSON[i] = (i * 11 + seed) & 0xff;

  const verificationData = Buffer.concat([
    Buffer.from(authData),
    nodeCrypto.createHash('sha256').update(Buffer.from(clientDataJSON)).digest(),
  ]);
  // DER, as a browser sends it — the SDK normalises it to raw r ‖ s itself.
  const signature = new Uint8Array(nodeCrypto.sign('sha256', verificationData, { key: privateKey }));

  return { authData, clientDataJSON, signature };
}

/** Install `navigator.credentials.get()` returning this assertion. */
function stubCredentialsGet(assertion: Assertion) {
  const asArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

  Object.defineProperty(globalThis, 'navigator', {
    value: {
      credentials: {
        get: jest.fn().mockResolvedValue({
          id: 'bGVnYXRvci1jcmVkZW50aWFs',
          type: 'public-key',
          response: {
            authenticatorData: asArrayBuffer(assertion.authData),
            clientDataJSON: asArrayBuffer(assertion.clientDataJSON),
            signature: asArrayBuffer(assertion.signature),
            userHandle: null,
          },
        }),
      },
    },
    writable: true,
    configurable: true,
  });
}

/** A server that only knows about `deployedAddress`. */
function stubServer(deployedAddress: string | null) {
  const lookedUp: string[] = [];
  const getContractData = jest.fn(async (address: string) => {
    lookedUp.push(address);
    if (address !== deployedAddress) throw new Error('Contract not found on-ledger');
    return {};
  });
  jest.mocked(SorobanRpc.Server).mockImplementation(() => ({ getContractData }) as never);
  return lookedUp;
}

describe('InvisibleWallet (vanilla).login({ credentialId })', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  it('recovers the signing key from the assertion and resolves the deployed wallet', async () => {
    const { privateKey, publicKeyBytes } = makePasskey();
    stubCredentialsGet(makeAssertion(privateKey, 5));
    const deployedAddress = computeWalletAddress(FACTORY_ADDRESS, publicKeyBytes, Networks.TESTNET);
    const lookedUp = stubServer(deployedAddress);

    const wallet = createInvisibleWallet(CONFIG);
    await expect(wallet.login({ credentialId: 'Y3JlZGVudGlhbC1pZA' })).resolves.toEqual({
      walletAddress: deployedAddress,
    });

    expect(wallet.address).toBe(deployedAddress);
    expect(wallet.isDeployed).toBe(true);
    expect(localStorage.getItem('invisible_wallet_address')).toBe(deployedAddress);
    // Only recovered candidates were queried — never a made-up address.
    expect(lookedUp.length).toBeGreaterThan(0);
    expect(lookedUp).toContain(deployedAddress);
  });

  it('finds the wallet through the same key recovery the standalone helper does', async () => {
    // Guards against the vanilla path drifting from the SDK helper it depends on:
    // the assertion the browser returns must itself yield the signer's key.
    const { privateKey, publicKeyBytes } = makePasskey();
    const assertion = makeAssertion(privateKey, 9);
    stubCredentialsGet(assertion);

    // The helper takes the raw r ‖ s form that a provider normalises DER into
    // (webauthn.ts and vanilla.ts both call derToRawSignature first).
    const recovered = recoverAssertionPublicKeys({
      ...assertion,
      signature: derToRawSignature(assertion.signature.buffer as ArrayBuffer),
    }).map(key => computeWalletAddress(FACTORY_ADDRESS, key, Networks.TESTNET));
    const deployedAddress = computeWalletAddress(FACTORY_ADDRESS, publicKeyBytes, Networks.TESTNET);
    expect(recovered).toContain(deployedAddress);

    const wallet = createInvisibleWallet(CONFIG);
    stubServer(deployedAddress);
    await expect(wallet.login({ credentialId: 'Y3JlZGVudGlhbC1pZA' })).resolves.toEqual({
      walletAddress: deployedAddress,
    });
  });

  it('returns null rather than adopting an address the chain does not know', async () => {
    const { privateKey } = makePasskey();
    stubCredentialsGet(makeAssertion(privateKey, 13));
    stubServer(null);

    const wallet = createInvisibleWallet(CONFIG);
    await expect(wallet.login({ credentialId: 'Y3JlZGVudGlhbC1pZA' })).resolves.toBeNull();
    expect(wallet.address).toBeNull();
    expect(localStorage.getItem('invisible_wallet_address')).toBeNull();
  });

  it('still uses a stored address without prompting for a passkey', async () => {
    const { privateKey, publicKeyBytes } = makePasskey();
    stubCredentialsGet(makeAssertion(privateKey, 17));
    const stored = computeWalletAddress(FACTORY_ADDRESS, publicKeyBytes, Networks.TESTNET);
    localStorage.setItem('invisible_wallet_address', stored);
    stubServer(stored);

    const wallet = createInvisibleWallet(CONFIG);
    await expect(wallet.login()).resolves.toEqual({ walletAddress: stored });
    expect(navigator.credentials.get).not.toHaveBeenCalled();
  });
});
