/**
 * Adding a second passkey must never change which wallet this device controls.
 *
 * The first "Add a passkey" button called the SDK's register(), which rewrote
 * the wallet address, credential id and public key — the primary binding the
 * fee payer and every signature derive from. These tests drive the real
 * add-a-device flow and its real storage against an in-memory keychain, with
 * only the passkey prompt, the signing ceremony and the RPC standing in, and
 * assert the primary binding is byte-for-byte the same afterwards — on
 * success, on cancellation, and on every kind of failure.
 */

// `mock`-prefixed so jest's hoisted factories may close over them.
const mockStore = new Map<string, string>();
const mockServer = {
  getAccount: jest.fn(),
  sendTransaction: jest.fn(),
};

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => (mockStore.has(key) ? mockStore.get(key)! : null)),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockStore.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockStore.delete(key);
  }),
}));

jest.mock('../passkey', () => ({
  createSignerPasskey: jest.fn(),
  registerPasskeySigner: jest.fn(() => () => undefined),
}));
jest.mock('../walletConnect', () => ({ signXdrPayload: jest.fn() }));
jest.mock('../contractSpend', () => ({ isWalletDeployed: jest.fn(async () => true) }));
jest.mock('../signers', () => ({ readSigners: jest.fn() }));
jest.mock('../sendPayment', () => ({ pollForResult: jest.fn() }));
jest.mock('../network', () => ({
  hydrateNetwork: async () => undefined,
  getNetworkName: () => 'testnet',
  getNetwork: () => ({
    name: 'testnet',
    networkPassphrase: 'Test SDF Network ; September 2015',
    rpcUrl: 'https://rpc.invalid',
  }),
}));
jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return { ...actual, rpc: { ...actual.rpc, Server: jest.fn(() => mockServer) } };
});

import { readFileSync } from 'fs';
import { join } from 'path';
import { Account, Keypair, StrKey } from '@stellar/stellar-sdk';
import { ADDITIONAL_SIGNERS_KEY, isPrimaryBindingKey } from '@veil/sdk';

import { addPasskeySigner, finishPendingSigner } from '../addPasskeySigner';
import { forgetPendingSigner, listAdditionalSigners } from '../additionalSigners';
import { isWalletDeployed } from '../contractSpend';
import { createSignerPasskey } from '../passkey';
import { PASSKEY_CANCELLED_MESSAGE, PasskeyCeremonyError } from '../passkeyOutcome';
import { pollForResult } from '../sendPayment';
import { readSigners } from '../signers';
import { SecureKey } from '../storage';
import { signXdrPayload } from '../walletConnect';

const mockCreate = createSignerPasskey as jest.Mock;
const mockSignXdr = signXdrPayload as jest.Mock;
const mockReadSigners = readSigners as jest.Mock;
const mockPoll = pollForResult as jest.Mock;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const WALLET = StrKey.encodeContract(Buffer.alloc(32, 0x11));
const FEE_PAYER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x55));

function p256(fill: number): Buffer {
  const key = Buffer.alloc(65, fill);
  key[0] = 0x04;
  return key;
}
const PRIMARY_KEY = p256(1).toString('hex');
const NEW_KEY = p256(2);

const PRIMARY_BINDING: Record<string, string> = {
  [SecureKey.walletAddress]: WALLET,
  [SecureKey.passkeyId]: 'cHJpbWFyeS1jcmVk',
  [SecureKey.passkeyPublicKey]: PRIMARY_KEY,
  [SecureKey.signerSecret]: FEE_PAYER.secret(),
};

function primarySnapshot(): Record<string, string | undefined> {
  return Object.fromEntries(Object.keys(PRIMARY_BINDING).map((k) => [k, mockStore.get(k)]));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
  for (const [k, v] of Object.entries(PRIMARY_BINDING)) mockStore.set(k, v);

  mockServer.getAccount.mockImplementation(async () => new Account(FEE_PAYER.publicKey(), '41'));
  mockServer.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'b'.repeat(64) });
  mockCreate.mockResolvedValue({ credentialId: 'bmV3LWNyZWQ', publicKey: new Uint8Array(NEW_KEY), transports: ['hybrid'] });
  // The real ceremony is covered by signXdrPayload.test.ts; here it just hands
  // back the transaction it was given.
  mockSignXdr.mockImplementation(async (xdr: string) => xdr);
  mockPoll.mockResolvedValue('b'.repeat(64));
  mockReadSigners.mockResolvedValue([
    { index: 0, publicKey: PRIMARY_KEY },
    { index: 1, publicKey: NEW_KEY.toString('hex') },
  ]);
});

// ── Success ──────────────────────────────────────────────────────────────────

describe('addPasskeySigner', () => {
  it('adds the key on chain and leaves the address, credential and fee payer untouched', async () => {
    const outcome = await addPasskeySigner();

    expect(outcome.walletAddress).toBe(WALLET);
    expect(outcome.signer).toEqual(expect.objectContaining({ status: 'active', signerIndex: 1, publicKey: NEW_KEY.toString('hex') }));
    expect(primarySnapshot()).toEqual(PRIMARY_BINDING);
    expect(await listAdditionalSigners()).toEqual([expect.objectContaining({ credentialId: 'bmV3LWNyZWQ', status: 'active' })]);
  });

  it('writes nothing to the keychain except the additional-signer record', async () => {
    const { setItemAsync, deleteItemAsync } = jest.requireMock('expo-secure-store');
    await addPasskeySigner();

    const written = new Set((setItemAsync as jest.Mock).mock.calls.map(([k]) => k));
    expect([...written]).toEqual([SecureKey.additionalSigners]);
    expect(deleteItemAsync).not.toHaveBeenCalled();
  });

  it('submits add_signer for the NEW key, through the passkey-signed ceremony', async () => {
    await addPasskeySigner();

    const xdr = mockSignXdr.mock.calls[0][0] as string;
    const { TransactionBuilder } = jest.requireActual('@stellar/stellar-sdk');
    const tx = TransactionBuilder.fromXDR(xdr, 'Test SDF Network ; September 2015');
    const call = tx.operations[0].func.invokeContract();
    expect(call.functionName().toString()).toBe('add_signer');
    expect(Buffer.from(call.args()[0].bytes())).toEqual(NEW_KEY);
    expect(tx.source).toBe(FEE_PAYER.publicKey());
  });

  it('asks the platform for a new credential that excludes the primary one', async () => {
    await addPasskeySigner();
    expect(mockCreate).toHaveBeenCalledWith(expect.arrayContaining([{ id: PRIMARY_BINDING[SecureKey.passkeyId] }]));
  });

  // ── Failing safely ─────────────────────────────────────────────────────────

  it('cancelling the new passkey leaves the keychain exactly as it was', async () => {
    mockCreate.mockRejectedValue(new PasskeyCeremonyError('cancelled', 'Passkey creation cancelled. Nothing was added.'));

    await expect(addPasskeySigner()).rejects.toMatchObject({ outcome: 'cancelled' });
    expect(Object.fromEntries(mockStore)).toEqual(PRIMARY_BINDING);
    expect(mockServer.sendTransaction).not.toHaveBeenCalled();
  });

  it('declining the approval with this phone’s passkey forgets the new key; binding intact', async () => {
    mockSignXdr.mockRejectedValue(new PasskeyCeremonyError('cancelled', PASSKEY_CANCELLED_MESSAGE));

    await expect(addPasskeySigner()).rejects.toMatchObject({ outcome: 'cancelled' });
    expect(primarySnapshot()).toEqual(PRIMARY_BINDING);
    expect(await listAdditionalSigners()).toEqual([]);
    expect(mockServer.sendTransaction).not.toHaveBeenCalled();
  });

  it('a simulation/SDK error before submission is the same: nothing recorded, binding intact', async () => {
    mockSignXdr.mockRejectedValue(new Error('Simulation failed: HostError: Error(Contract, #8)'));

    await expect(addPasskeySigner()).rejects.toThrow(/Simulation failed/);
    expect(primarySnapshot()).toEqual(PRIMARY_BINDING);
    expect(await listAdditionalSigners()).toEqual([]);
  });

  it('a transaction the network rejects outright is forgotten too', async () => {
    mockServer.sendTransaction.mockResolvedValue({ status: 'ERROR', errorResult: undefined });

    await expect(addPasskeySigner()).rejects.toThrow();
    expect(primarySnapshot()).toEqual(PRIMARY_BINDING);
    expect(await listAdditionalSigners()).toEqual([]);
  });

  it('an outcome lost AFTER submission keeps the key as pending so it can be settled; binding intact', async () => {
    mockPoll.mockRejectedValue(new Error('Transaction timed out'));

    await expect(addPasskeySigner()).rejects.toThrow(/timed out/);
    expect(primarySnapshot()).toEqual(PRIMARY_BINDING);
    expect(await listAdditionalSigners()).toEqual([expect.objectContaining({ status: 'pending' })]);
  });

  it('refuses before any prompt when the wallet is not on chain yet', async () => {
    (isWalletDeployed as jest.Mock).mockResolvedValueOnce(false);

    await expect(addPasskeySigner()).rejects.toThrow(/first payment/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('refuses before any prompt when this device holds no primary passkey', async () => {
    mockStore.delete(SecureKey.passkeyId);

    await expect(addPasskeySigner()).rejects.toThrow(/no passkey on this device/);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ── Settling a pending key ───────────────────────────────────────────────────

describe('finishPendingSigner', () => {
  async function leavePending() {
    mockPoll.mockRejectedValueOnce(new Error('Transaction timed out'));
    await addPasskeySigner().catch(() => undefined);
    jest.clearAllMocks();
  }

  it('marks it active without resubmitting when the chain already lists it', async () => {
    await leavePending();

    const outcome = await finishPendingSigner('bmV3LWNyZWQ');

    expect(outcome.signer.status).toBe('active');
    expect(mockSignXdr).not.toHaveBeenCalled();
    expect(primarySnapshot()).toEqual(PRIMARY_BINDING);
  });

  it('resubmits only when the chain does not list it', async () => {
    await leavePending();
    mockReadSigners.mockResolvedValueOnce([{ index: 0, publicKey: PRIMARY_KEY }]);

    await finishPendingSigner('bmV3LWNyZWQ');

    expect(mockSignXdr).toHaveBeenCalledTimes(1);
    expect(primarySnapshot()).toEqual(PRIMARY_BINDING);
  });

  it('an active signer cannot be "forgotten" locally — that would hide a key that can still spend', async () => {
    await addPasskeySigner();
    await expect(forgetPendingSigner('bmV3LWNyZWQ')).rejects.toThrow(/would not remove it on chain/);
  });
});

// ── Structural guards ────────────────────────────────────────────────────────

describe('the add-a-device path cannot reach the primary binding', () => {
  // Code only: the modules' comments explain why register() is not used, by name.
  const source = (file: string) =>
    readFileSync(join(__dirname, '..', file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it.each(['addPasskeySigner.ts', 'additionalSigners.ts'])('%s imports no wallet-binding writer and never calls register()', (file) => {
    const code = source(file);
    for (const writer of [
      'setWalletAddress',
      'setPasskeyId',
      'setPasskeyPublicKey',
      'setPasskeyCredential',
      'setSignerSecret',
      'writeSdkMirror',
      'clearWalletStore',
      'resetWallet',
    ]) {
      expect(code).not.toMatch(new RegExp(`\\b${writer}\\b`));
    }
    expect(code).not.toMatch(/\.register\(|\bregister\(/);
  });

  it('the record lives where the SDK and the reset path expect, and is not a primary key', () => {
    expect(SecureKey.additionalSigners).toBe(ADDITIONAL_SIGNERS_KEY);
    expect(isPrimaryBindingKey(SecureKey.additionalSigners)).toBe(false);
    for (const key of [SecureKey.walletAddress, SecureKey.passkeyId, SecureKey.passkeyPublicKey, SecureKey.signerSecret]) {
      expect(isPrimaryBindingKey(key)).toBe(true);
    }
  });
});

// ── The deployed-contract overwrite defect (#1176) ───────────────────────────

describe('a signer disappearing while another is added', () => {
  // `add_signer` used to allocate its index as `next_index = len()`, so after a
  // middle `remove_signer` the next add wrote over a live slot and silently
  // replaced another key. #1233 fixed the contract source on 2026-10-22, but
  // wallets are not upgradeable — every wallet deployed before that still has
  // the old code and always will. The client is the only place left to notice.
  it('refuses to report success when the add replaced an existing signer', async () => {
    mockReadSigners
      // Before the write: primary plus an older additional signer.
      .mockResolvedValueOnce([
        { index: 0, publicKey: PRIMARY_KEY },
        { index: 1, publicKey: 'cc'.repeat(65) },
      ])
      // After: the new key took index 1 and the older signer is gone.
      .mockResolvedValueOnce([
        { index: 0, publicKey: PRIMARY_KEY },
        { index: 1, publicKey: NEW_KEY.toString('hex') },
      ]);

    await expect(addPasskeySigner()).rejects.toThrow(/removed an existing signer/i);
  });

  it('reports success normally when every previous signer survives', async () => {
    mockReadSigners
      .mockResolvedValueOnce([{ index: 0, publicKey: PRIMARY_KEY }])
      .mockResolvedValueOnce([
        { index: 0, publicKey: PRIMARY_KEY },
        { index: 1, publicKey: NEW_KEY.toString('hex') },
      ]);

    const outcome = await addPasskeySigner();
    expect(outcome.signer.status).toBe('active');
  });

  it('still reports success when the chain cannot be read, rather than blocking the add', async () => {
    // Settling is best effort: the signer is already on chain, so a flaky RPC
    // read must not be reported as a failed add.
    mockReadSigners.mockRejectedValue(new Error('rpc unreachable'));

    const outcome = await addPasskeySigner();
    expect(outcome.signer.status).toBe('pending');
  });
});
