/**
 * The standalone auth-entry half of the signing surface.
 *
 * SEP-43 `signAuthEntry` hands the wallet an authorization entry, not a
 * transaction: the dApp has already simulated and will assemble and submit. So
 * this path must fill in exactly one credential and change nothing else — and it
 * must produce the *same* bytes the transaction path produces for the same
 * payload, because the contract's `__check_auth` cannot tell which door the
 * signature came through.
 *
 * The passkey is a real P-256 key behind a mocked `react-native-passkeys`, so the
 * signature in the output can be verified the way the contract verifies it. The
 * RPC is a fake that answers the one simulation this path makes: reading the
 * wallet's nonce.
 */
import {
  Address,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  hash,
  nativeToScVal,
  rpc as SorobanRpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { createHash, generateKeyPairSync, verify } from 'crypto';

import { registerPasskeySigner } from '../passkey';
import { PasskeyCeremonyError, isPasskeyCancellation } from '../passkeyOutcome';
import { registerAuthEntrySigner, signAuthEntryPayload } from '../walletConnect';

const WALLET = StrKey.encodeContract(Buffer.alloc(32, 0x11));
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 0x22));
const RECIPIENT = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x33)).publicKey();

const LATEST_LEDGER = 1_000;
const AUTH_NONCE = 777n;
const WALLET_NONCE = 5n;

const mockPasskey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const mockPasskeyPublicKey = mockPasskey.publicKey
  .export({ format: 'der', type: 'spki' })
  .subarray(-65);
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

jest.mock('../polyfills', () => ({}));
jest.mock('@walletconnect/core', () => ({ Core: jest.fn() }));
jest.mock('@walletconnect/utils', () => ({ getSdkError: jest.fn() }));
jest.mock('@reown/walletkit', () => ({ WalletKit: { init: jest.fn() } }));

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digest: async (_alg: string, data: Uint8Array) =>
    Uint8Array.from(require('crypto').createHash('sha256').update(data).digest()).buffer,
  getRandomBytes: (n: number) => new Uint8Array(n),
}));

jest.mock('../walletStore', () => ({
  getSignerSecret: async () =>
    require('@stellar/stellar-sdk').Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x55)).secret(),
  getPasskeyId: async () => 'dGVzdC1jcmVkZW50aWFs',
  getPasskeyPublicKey: async () => Buffer.from(mockPasskeyPublicKey).toString('hex'),
}));

jest.mock('../network', () => ({
  getNetwork: () => ({
    name: 'testnet',
    networkPassphrase: 'Test SDF Network ; September 2015',
    rpcUrl: 'https://rpc.invalid',
  }),
}));

/** What the authenticator was asked to sign, and what it returned. */
const mockCeremonies: { challenge: string; derSignature: Buffer }[] = [];

jest.mock('react-native-passkeys', () => ({
  isSupported: () => true,
  get: async ({ challenge, rpId }: { challenge: string; rpId: string }) => {
    const nodeCrypto = require('crypto');
    const b64url = (b: Buffer) => b.toString('base64url');
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge, origin: `https://${rpId}` }),
    );
    const authData = Buffer.concat([
      nodeCrypto.createHash('sha256').update(rpId).digest(),
      Buffer.from([0x05, 0, 0, 0, 1]),
    ]);
    const signed = Buffer.concat([
      authData,
      nodeCrypto.createHash('sha256').update(clientDataJSON).digest(),
    ]);
    const raw: Buffer = nodeCrypto.sign('sha256', signed, {
      key: mockPasskey.privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    // Always hand back the high form: the wallet has to low-S it, and Soroban's
    // secp256r1_verify rejects anything else.
    const derSignature = mockToHighSDer(raw);
    mockCeremonies.push({ challenge, derSignature });
    return {
      response: {
        authenticatorData: b64url(authData),
        clientDataJSON: b64url(clientDataJSON),
        signature: b64url(derSignature),
      },
    };
  },
}));

function mockToHighSDer(raw: Buffer): Buffer {
  const n = P256_N;
  const toBig = (b: Buffer) => BigInt(`0x${b.toString('hex')}`);
  const toDerInt = (v: bigint) => {
    let bytes = Buffer.from(v.toString(16).padStart(64, '0'), 'hex');
    while (bytes.length > 1 && bytes[0] === 0 && bytes[1] < 0x80) bytes = bytes.subarray(1);
    if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
    return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
  };
  const r = toBig(raw.subarray(0, 32));
  let s = toBig(raw.subarray(32));
  if (s <= n >> 1n) s = n - s;
  const body = Buffer.concat([toDerInt(r), toDerInt(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function entryXdr(address = WALLET): string {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(address).toScAddress(),
        nonce: xdr.Int64.fromString(AUTH_NONCE.toString()),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(TOKEN).toScAddress(),
          functionName: 'transfer',
          args: [
            nativeToScVal(Address.fromString(WALLET)),
            nativeToScVal(Address.fromString(RECIPIENT)),
            nativeToScVal(100n, { type: 'i128' }),
          ],
        }),
      ),
      subInvocations: [],
    }),
  }).toXDR('base64');
}

type NonceProbe = () => { error?: string; retval?: xdr.ScVal } | Error;

let nonceProbe: NonceProbe;
let simulations: string[];

function invokedFunctionName(tx: Transaction): string {
  const op = tx.operations[0] as Operation.InvokeHostFunction;
  return op.func.invokeContract().functionName().toString();
}

function parsed(xdrString: string): xdr.SorobanAuthorizationEntry {
  return xdr.SorobanAuthorizationEntry.fromXDR(xdrString, 'base64');
}

function credentialOf(xdrString: string): xdr.SorobanAddressCredentials {
  return parsed(xdrString).credentials().address();
}

function signatureVector(xdrString: string): xdr.ScVal[] {
  return credentialOf(xdrString).signature().vec() ?? [];
}

/** The only simulation this path makes: `get_nonce` on the wallet contract. */
async function fakeSimulate(tx: Transaction) {
  const base = { id: '1', latestLedger: LATEST_LEDGER, events: [] };
  simulations.push(invokedFunctionName(tx));

  const outcome = nonceProbe();
  if (outcome instanceof Error) throw outcome;
  if (outcome.error) return SorobanRpc.parseRawSimulation({ ...base, error: outcome.error });
  return SorobanRpc.parseRawSimulation({
    ...base,
    transactionData: new SorobanDataBuilder().build().toXDR('base64'),
    minResourceFee: '100',
    results: [{ auth: [], xdr: outcome.retval!.toXDR('base64') }],
  });
}

beforeAll(() => {
  registerPasskeySigner();
});

beforeEach(() => {
  mockCeremonies.length = 0;
  simulations = [];
  nonceProbe = () => ({ retval: nativeToScVal(WALLET_NONCE, { type: 'u64' }) });
  jest.spyOn(SorobanRpc.Server.prototype, 'simulateTransaction').mockImplementation(
    fakeSimulate as unknown as SorobanRpc.Server['simulateTransaction'],
  );
  jest
    .spyOn(SorobanRpc.Server.prototype, 'getLatestLedger')
    .mockResolvedValue({ id: 'x', protocolVersion: '22', sequence: LATEST_LEDGER });
  jest
    .spyOn(SorobanRpc.Server.prototype, 'getAccount')
    .mockImplementation(async (id: string) => new (require('@stellar/stellar-sdk').Account)(id, '41'));
  jest
    .spyOn(SorobanRpc.Server.prototype, 'sendTransaction')
    .mockResolvedValue({ status: 'PENDING', hash: 'x' } as never);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

// ── 1. What comes back ────────────────────────────────────────────────────────

describe('the signed entry', () => {
  it('fills in the credential and changes nothing else', async () => {
    const input = entryXdr();
    const output = await signAuthEntryPayload(input);

    const before = parsed(input);
    const after = parsed(output);
    expect(after.rootInvocation().toXDR('base64')).toBe(before.rootInvocation().toXDR('base64'));
    expect(credentialOf(output).nonce().toString()).toBe(AUTH_NONCE.toString());
    expect(Address.fromScAddress(credentialOf(output).address()).toString()).toBe(WALLET);
  });

  it('answers in base64, the shape SEP-43 documents', async () => {
    const output = await signAuthEntryPayload(entryXdr());

    expect(typeof output).toBe('string');
    expect(output).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('sends [pubkey, authData, clientDataJSON, signature, nonce]', async () => {
    const vector = signatureVector(await signAuthEntryPayload(entryXdr()));

    expect(vector).toHaveLength(5);
    expect(Buffer.from(vector[0].bytes())).toEqual(Buffer.from(mockPasskeyPublicKey));
    expect(scValToNative(vector[4])).toBe(WALLET_NONCE);
  });

  it('drops the nonce only for a wallet that has no get_nonce at all', async () => {
    nonceProbe = () => ({ error: 'HostError: Error(WasmVm, MissingValue)' });

    expect(signatureVector(await signAuthEntryPayload(entryXdr()))).toHaveLength(4);
  });
});

// ── 2. What the passkey was asked to sign ─────────────────────────────────────

describe('the payload behind the signature', () => {
  it('signs the same expiration ledger it attaches', async () => {
    const output = await signAuthEntryPayload(entryXdr());
    const credentials = credentialOf(output);

    expect(credentials.signatureExpirationLedger()).toBe(LATEST_LEDGER + 100);

    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: hash(Buffer.from(Networks.TESTNET)),
        nonce: credentials.nonce(),
        invocation: parsed(output).rootInvocation(),
        signatureExpirationLedger: credentials.signatureExpirationLedger(),
      }),
    );
    expect(mockCeremonies).toHaveLength(1);
    expect(mockCeremonies[0].challenge).toBe(hash(preimage.toXDR()).toString('base64url'));
  });

  it('puts a low-S signature in the credential, still valid for the passkey', async () => {
    const vector = signatureVector(await signAuthEntryPayload(entryXdr()));
    const authData = Buffer.from(vector[1].bytes());
    const clientDataJSON = Buffer.from(vector[2].bytes());
    const signature = Buffer.from(vector[3].bytes());

    expect(signature).toHaveLength(64);
    expect(BigInt(`0x${signature.subarray(32).toString('hex')}`) <= P256_N >> 1n).toBe(true);

    const signed = Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]);
    expect(
      verify('sha256', signed, { key: mockPasskey.publicKey, dsaEncoding: 'ieee-p1363' }, signature),
    ).toBe(true);
  });
});

// ── 3. What this path must never do ──────────────────────────────────────────

describe('the limits of the standalone path', () => {
  it('does not assemble, fee-bump, or submit anything', async () => {
    await signAuthEntryPayload(entryXdr());

    // The only simulation is the wallet's own nonce read. No recording mode, no
    // enforce mode, no rebuild: the dApp keeps the transaction.
    expect(simulations).toEqual(['get_nonce']);
    expect(SorobanRpc.Server.prototype.getAccount).not.toHaveBeenCalled();
    expect(SorobanRpc.Server.prototype.sendTransaction).not.toHaveBeenCalled();
  });

  it('reports a decline as a decline and never touches the passkey', async () => {
    registerAuthEntrySigner(async () => null);
    try {
      // A cancellation by shape, not by wording. The dApp bridge and the
      // WalletConnect handler both branch on `isPasskeyCancellation` to turn a
      // dismissed sheet into a rejection rather than a red banner, and a plain
      // `new Error('USER_REJECTED')` happens to satisfy that predicate through
      // its message text alone — so asserting the carried outcome is what keeps
      // this path from quietly losing the distinction again.
      const rejection = await signAuthEntryPayload(entryXdr()).then(
        () => null,
        (error: unknown) => error
      );
      expect(rejection).toBeInstanceOf(PasskeyCeremonyError);
      expect((rejection as PasskeyCeremonyError).outcome).toBe('cancelled');
      expect(isPasskeyCancellation(rejection)).toBe(true);
    } finally {
      registerPasskeySigner();
    }

    expect(mockCeremonies).toHaveLength(0);
  });

  it('refuses to sign, rather than drop the nonce, when the read keeps failing', async () => {
    jest.useFakeTimers();
    nonceProbe = () => ({ error: 'HostError: Error(Storage, ExceededLimit) — rate limited' });

    const pending = signAuthEntryPayload(entryXdr());
    const assertion = expect(pending).rejects.toThrow(/Could not read the wallet nonce/);
    await jest.runAllTimersAsync();
    await assertion;

    expect(mockCeremonies).toHaveLength(0);
  });

  it('will not sign an entry that carries no address credential', async () => {
    const entry = parsed(entryXdr());
    // The other credential the XDR defines authorises the source account, which
    // is not a passkey-signed wallet credential and is not ours to fill in.
    entry.credentials(xdr.SorobanCredentials.sorobanCredentialsSourceAccount());

    await expect(signAuthEntryPayload(entry.toXDR('base64'))).rejects.toThrow(/no wallet credential/);
    expect(mockCeremonies).toHaveLength(0);
  });

  it('refuses an XDR that is not an authorization entry at all', async () => {
    await expect(signAuthEntryPayload(Buffer.from('nonsense').toString('base64'))).rejects.toThrow();
    expect(simulations).toEqual([]);
  });
});
