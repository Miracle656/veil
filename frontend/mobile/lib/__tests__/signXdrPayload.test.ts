/**
 * The six things `__check_auth` needs from `signXdrPayload()`.
 *
 * A passkey-signed Soroban transaction only verifies when all six are right at
 * once, and getting any one wrong fails on-chain with an error that does not say
 * which. Each describe block below is one requirement, stated as a rule, with the
 * on-chain failure it prevents. The rejections themselves happen on-chain: in the
 * Soroban host (expiry, footprint, sequence, secp256r1 low-S) or in the contract
 * (vector format, see `contracts/invisible_wallet/src/auth_failure_tests.rs`).
 * This suite pins the wallet's half: that it builds what those checks accept.
 *
 * Nothing here touches a network or a device. The RPC is a fake that answers
 * the three simulations the function makes, and the passkey is a real P-256 key
 * behind a mocked `react-native-passkeys`, so every signature in the output can
 * be verified the way the contract verifies it.
 */
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  TransactionBuilder,
  hash,
  nativeToScVal,
  rpc as SorobanRpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { createHash, generateKeyPairSync, verify } from 'crypto';

import { registerPasskeySigner } from '../passkey';
import { signXdrPayload } from '../walletConnect';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const FEE_PAYER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x55));
const WALLET = StrKey.encodeContract(Buffer.alloc(32, 0x11));
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 0x22));
const RECIPIENT = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x33)).publicKey();
const DAPP_SOURCE = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x44)).publicKey();

const LATEST_LEDGER = 1_000;
const FEE_PAYER_SEQUENCE = '41';
const WALLET_NONCE = 5n;
const AUTH_NONCE = 777n;

// The passkey. `mock` prefix: jest.mock factories may only close over these.
const mockPasskey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const mockPasskeyPublicKey = mockPasskey.publicKey
  .export({ format: 'der', type: 'spki' })
  .subarray(-65); // uncompressed SEC1 point: 0x04 || x || y
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

// ── Module mocks ─────────────────────────────────────────────────────────────

// The WalletConnect client and its React Native polyfills load at import time
// and are ESM-only. signXdrPayload uses none of them.
jest.mock('../polyfills', () => ({}));
jest.mock('@walletconnect/core', () => ({ Core: jest.fn() }));
jest.mock('@walletconnect/utils', () => ({ getSdkError: jest.fn() }));
jest.mock('@walletconnect/web3wallet', () => ({ Web3Wallet: { init: jest.fn() } }));

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
    // rpIdHash || flags (UP | UV) || signCount
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
    // Authenticators may return either s or n - s; both verify under plain
    // ECDSA. Always return the high one, which Soroban's secp256r1_verify rejects.
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
  const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
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

// ── Fake RPC ─────────────────────────────────────────────────────────────────

function contractInstanceKey(contractId: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

function sorobanData(readOnly: xdr.LedgerKey[], resourceFee: number): string {
  return new SorobanDataBuilder()
    .setFootprint(readOnly, [])
    .setResources(1_000_000, 10_000, 1_000)
    .setResourceFee(resourceFee)
    .build()
    .toXDR('base64');
}

// Recording mode sees the token call but not the wallet's own storage, because
// `__check_auth` does not run until the entry is signed. Enforce mode does.
const RECORDING_DATA = sorobanData([contractInstanceKey(TOKEN)], 50_000);
const ENFORCE_DATA = sorobanData([contractInstanceKey(TOKEN), contractInstanceKey(WALLET)], 90_000);

const TRANSFER_ARGS = [
  nativeToScVal(Address.fromString(WALLET)),
  nativeToScVal(Address.fromString(RECIPIENT)),
  nativeToScVal(100n, { type: 'i128' }),
];

function recordingAuthEntry(): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(WALLET).toScAddress(),
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
          args: TRANSFER_ARGS,
        }),
      ),
      subInvocations: [],
    }),
  });
}

type NonceProbe = () => { error?: string; retval?: xdr.ScVal } | Error;

let nonceProbe: NonceProbe;
let simulations: { kind: 'recording' | 'nonce' | 'enforce' }[];

function invokedFunctionName(tx: Transaction): string {
  const op = tx.operations[0] as Operation.InvokeHostFunction;
  return op.func.invokeContract().functionName().toString();
}

function isSigned(tx: Transaction): boolean {
  const op = tx.operations[0] as Operation.InvokeHostFunction;
  return (op.auth ?? []).some(
    (entry) => entry.credentials().address().signature().switch().name !== 'scvVoid',
  );
}

async function fakeSimulate(tx: Transaction) {
  const base = { id: '1', latestLedger: LATEST_LEDGER, events: [] };

  if (invokedFunctionName(tx) === 'get_nonce') {
    simulations.push({ kind: 'nonce' });
    const outcome = nonceProbe();
    if (outcome instanceof Error) throw outcome;
    if (outcome.error) return SorobanRpc.parseRawSimulation({ ...base, error: outcome.error });
    return SorobanRpc.parseRawSimulation({
      ...base,
      transactionData: RECORDING_DATA,
      minResourceFee: '100',
      results: [{ auth: [], xdr: outcome.retval!.toXDR('base64') }],
    });
  }

  const enforce = isSigned(tx);
  simulations.push({ kind: enforce ? 'enforce' : 'recording' });
  return SorobanRpc.parseRawSimulation({
    ...base,
    transactionData: enforce ? ENFORCE_DATA : RECORDING_DATA,
    minResourceFee: enforce ? '90000' : '50000',
    results: [
      {
        auth: enforce ? [] : [recordingAuthEntry().toXDR('base64')],
        xdr: xdr.ScVal.scvVoid().toXDR('base64'),
      },
    ],
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** An unsigned `transfer` from the wallet, as a dApp would send it. */
function dappTransaction(): string {
  return new TransactionBuilder(new Account(DAPP_SOURCE, '9'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.invokeContractFunction({ contract: TOKEN, function: 'transfer', args: TRANSFER_ARGS }),
    )
    .setTimeout(30)
    .build()
    .toXDR();
}

async function sign_(): Promise<Transaction> {
  const signed = await signXdrPayload(dappTransaction());
  return TransactionBuilder.fromXDR(signed, Networks.TESTNET) as Transaction;
}

function hostOp(tx: Transaction): Operation.InvokeHostFunction {
  return tx.operations[0] as Operation.InvokeHostFunction;
}

function walletCredentials(tx: Transaction): xdr.SorobanAddressCredentials {
  const auth = hostOp(tx).auth ?? [];
  expect(auth).toHaveLength(1);
  return auth[0].credentials().address();
}

function signatureVector(tx: Transaction): xdr.ScVal[] {
  return walletCredentials(tx).signature().vec() ?? [];
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
    .mockImplementation(async (id: string) => new Account(id, FEE_PAYER_SEQUENCE));
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

// ── 1. Host function ─────────────────────────────────────────────────────────

describe('requirement 1: the host function', () => {
  // The dApp's invocation must reach the chain unchanged, carrying the signed
  // auth entry. Drop the entry and the host has nothing to call __check_auth
  // with; alter the call and the signed payload no longer matches it.

  it('resubmits the dApp host function unchanged', async () => {
    const input = TransactionBuilder.fromXDR(dappTransaction(), Networks.TESTNET) as Transaction;
    const output = await sign_();

    expect(output.operations).toHaveLength(1);
    expect(hostOp(output).func.toXDR('base64')).toBe(hostOp(input).func.toXDR('base64'));
  });

  it('attaches the signed wallet auth entry to it', async () => {
    const output = await sign_();

    const credentials = walletCredentials(output);
    expect(Address.fromScAddress(credentials.address()).toString()).toBe(WALLET);
    expect(credentials.signature().switch().name).toBe('scvVec');
  });
});

// ── 2. Low-S ─────────────────────────────────────────────────────────────────

describe('requirement 2: a low-S signature', () => {
  // Soroban's secp256r1_verify rejects s > n/2 to stop signature malleability,
  // and authenticators are free to return either form. The authenticator in
  // this suite always returns the high one.

  it('is given a high-S signature by the authenticator', async () => {
    await sign_();

    const der = mockCeremonies[0].derSignature;
    const sLength = der[5 + der[3]];
    const s = BigInt(`0x${der.subarray(der.length - sLength).toString('hex')}`);
    expect(s > P256_N >> 1n).toBe(true);
  });

  it('puts a low-S signature in the credential, still valid for the passkey', async () => {
    const vector = signatureVector(await sign_());
    const authData = Buffer.from(vector[1].bytes());
    const clientDataJSON = Buffer.from(vector[2].bytes());
    const signature = Buffer.from(vector[3].bytes());

    expect(signature).toHaveLength(64);
    const s = BigInt(`0x${signature.subarray(32).toString('hex')}`);
    expect(s <= P256_N >> 1n).toBe(true);

    const signed = Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]);
    expect(
      verify('sha256', signed, { key: mockPasskey.publicKey, dsaEncoding: 'ieee-p1363' }, signature),
    ).toBe(true);
  });
});

// ── 3. Expiration ledger ─────────────────────────────────────────────────────

describe('requirement 3: an expiration ledger', () => {
  // Recording-mode simulation returns entries with signatureExpirationLedger 0,
  // which the host treats as already expired. A real future ledger has to go
  // into both the credential and the preimage the passkey signs; if the two
  // differ, the host computes a different payload and the challenge check fails.

  it('sets a future expiration on the credential', async () => {
    const credentials = walletCredentials(await sign_());

    expect(credentials.signatureExpirationLedger()).toBe(LATEST_LEDGER + 100);
  });

  it('signs the same expiration it attaches', async () => {
    const output = await sign_();
    const credentials = walletCredentials(output);

    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: hash(Buffer.from(Networks.TESTNET)),
        nonce: credentials.nonce(),
        invocation: (hostOp(output).auth ?? [])[0].rootInvocation(),
        signatureExpirationLedger: credentials.signatureExpirationLedger(),
      }),
    );
    // What the host will compute is what the passkey must have been asked to sign.
    const expectedChallenge = hash(preimage.toXDR()).toString('base64url');

    expect(mockCeremonies[0].challenge).toBe(expectedChallenge);
  });
});

// ── 4. Footprint ─────────────────────────────────────────────────────────────

describe('requirement 4: a footprint from re-simulation', () => {
  // __check_auth reads the wallet's own storage (signers, nonce, rp id). Recording
  // mode cannot see those reads because the entry is unsigned when it runs, so
  // its footprint omits them and the transaction fails with a footprint error.
  // Only a second, enforce-mode simulation of the signed transaction finds them.

  it('simulates again after signing', async () => {
    await sign_();

    expect(simulations.map((s) => s.kind)).toEqual(['recording', 'nonce', 'enforce']);
  });

  it('assembles with the enforce-mode footprint, which includes the wallet', async () => {
    const output = await sign_();
    const data = output.toEnvelope().v1().tx().ext().sorobanData();
    const readOnly = data.resources().footprint().readOnly().map((key) => key.toXDR('base64'));

    expect(readOnly).toContain(contractInstanceKey(WALLET).toXDR('base64'));
    expect(data.resourceFee().toString()).toBe('90000');
  });
});

// ── 5. Sequence ──────────────────────────────────────────────────────────────

describe('requirement 5: the right sequence', () => {
  // The fee payer is the transaction source, so its next sequence number has to
  // come from the network at signing time. A stale or invented one fails with
  // txBadSeq before __check_auth is ever reached.

  it('uses the fee payer as source, at its next sequence number', async () => {
    const output = await sign_();

    expect(output.source).toBe(FEE_PAYER.publicKey());
    expect(output.sequence).toBe((BigInt(FEE_PAYER_SEQUENCE) + 1n).toString());
  });

  it('is signed by the fee payer', async () => {
    const output = await sign_();

    expect(output.signatures).toHaveLength(1);
    expect(FEE_PAYER.verify(output.hash(), output.signatures[0].signature())).toBe(true);
  });
});

// ── 6. Five-element signature vector ─────────────────────────────────────────

describe('requirement 6: a 5-element signature vector', () => {
  // __check_auth's WebAuthn branch accepts exactly
  // [pubkey, authData, clientDataJSON, signature, nonce] and rejects anything
  // else as InvalidSignatureFormat (#2). The nonce is the wallet's own counter,
  // read through get_nonce.

  it('sends [pubkey, authData, clientDataJSON, signature, nonce]', async () => {
    const vector = signatureVector(await sign_());

    expect(vector).toHaveLength(5);
    expect(Buffer.from(vector[0].bytes())).toEqual(Buffer.from(mockPasskeyPublicKey));
    expect(vector[4].switch().name).toBe('scvU64');
    expect(scValToNative(vector[4])).toBe(WALLET_NONCE);
  });

  it('still sends 5 elements when the nonce read fails once and then succeeds', async () => {
    jest.useFakeTimers();
    let calls = 0;
    nonceProbe = () =>
      ++calls === 1
        ? new Error('socket hang up')
        : { retval: nativeToScVal(WALLET_NONCE, { type: 'u64' }) };

    const pending = sign_();
    await jest.runAllTimersAsync();
    const vector = signatureVector(await pending);

    expect(vector).toHaveLength(5);
  });

  it('refuses to sign, rather than drop the nonce, when the read keeps failing', async () => {
    // Dropping it is what broke the first mainnet spend: a transient RPC error
    // was read as "legacy wallet" and the contract rejected the 4-element vector.
    jest.useFakeTimers();
    nonceProbe = () => ({ error: 'HostError: Error(Storage, ExceededLimit) — rate limited' });

    const pending = sign_();
    const assertion = expect(pending).rejects.toThrow(/Could not read the wallet nonce/);
    await jest.runAllTimersAsync();
    await assertion;
    expect(mockCeremonies).toHaveLength(0);
  });

  it('drops the nonce only for a wallet that has no get_nonce at all', async () => {
    // Legacy wallets predate get_nonce and verify a 4-element vector. This is
    // the only path allowed to produce one.
    nonceProbe = () => ({ error: 'HostError: Error(WasmVm, MissingValue)' });

    const vector = signatureVector(await sign_());

    expect(vector).toHaveLength(4);
  });
});
