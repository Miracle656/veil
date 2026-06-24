import { renderHook, act } from '@testing-library/react';
import { useInvisibleWallet } from '../src/useInvisibleWallet';

// ── @stellar/stellar-sdk mock ─────────────────────────────────────────────────
jest.mock('@stellar/stellar-sdk', () => ({
  Networks: {
    TESTNET: 'Test SDF Network ; September 2015',
    PUBLIC:  'Public Global Stellar Network ; September 2015',
  },
  BASE_FEE: '100',
  rpc: {
    Server: jest.fn().mockImplementation(() => ({
      getContractData:     jest.fn().mockResolvedValue({}),
      simulateTransaction: jest.fn().mockResolvedValue({
        result: { retval: {} },
        minResourceFee: '0',
        transactionData: {},
        events: [],
        latestLedger: 1,
      }),
      sendTransaction: jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'mock-hash' }),
      getTransaction:  jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
    })),
    Api: {
      GetTransactionStatus: { SUCCESS: 'SUCCESS', NOT_FOUND: 'NOT_FOUND', FAILED: 'FAILED' },
      isSimulationError: jest.fn(() => false),
    },
    Durability: { Persistent: 'persistent', Temporary: 'temporary' },
    assembleTransaction: jest.fn().mockReturnValue({
      build: jest.fn().mockReturnValue({ sign: jest.fn(), toXDR: jest.fn() }),
    }),
  },
  Horizon: {
    Server: jest.fn().mockImplementation(() => ({
      loadAccount: jest.fn().mockResolvedValue({
        balances: [],
        sequence: '0',
        account_id: 'GPUBKEY',
      }),
    })),
  },
  Account: jest.fn().mockImplementation((_id: string, seq: string) => ({
    accountId: () => _id,
    sequenceNumber: () => seq,
    incrementSequenceNumber: jest.fn(),
  })),
  Contract: jest.fn().mockImplementation(() => ({
    call: jest.fn().mockReturnValue({ toXDR: jest.fn() }),
  })),
  Keypair: {
    random:     jest.fn().mockReturnValue({ publicKey: () => 'GPUBKEY', secret: () => 'SSECRET' }),
    fromSecret: jest.fn().mockReturnValue({ publicKey: () => 'GPUBKEY', secret: () => 'SSECRET' }),
  },
  TransactionBuilder: jest.fn().mockImplementation(() => ({
    addOperation: jest.fn().mockReturnThis(),
    setTimeout:   jest.fn().mockReturnThis(),
    build:        jest.fn().mockReturnValue({ sign: jest.fn(), toXDR: jest.fn() }),
  })),
  StrKey: { isValidContract: jest.fn(() => true), isValidEd25519PublicKey: jest.fn(() => true) },
  xdr: {
    ScVal: { scvLedgerKeyContractInstance: jest.fn().mockReturnValue({}) },
  },
  nativeToScVal:  jest.fn().mockReturnValue({}),
  scValToNative:  jest.fn().mockReturnValue(BigInt(0)),
  Asset: {
    native: jest.fn().mockReturnValue({ contractId: jest.fn().mockReturnValue('CSAC') }),
  },
}));

// ── ./utils mock ──────────────────────────────────────────────────────────────
jest.mock('../src/utils', () => ({
  bufferToHex:          jest.fn(() => 'aabbcc1122334455'),
  hexToUint8Array:      jest.fn(() => new Uint8Array(65).fill(4)),
  derToRawSignature:    jest.fn(() => new Uint8Array(64).fill(1)),
  extractP256PublicKey: jest.fn().mockResolvedValue(new Uint8Array(65).fill(4)),
  computeWalletAddress: jest.fn(() => 'CWALLET_ADDRESS_MOCK'),
}));

// ── WebAuthn mock ─────────────────────────────────────────────────────────────
const mockCredentialsCreate = jest.fn();
const mockCredentialsGet    = jest.fn();

Object.defineProperty(global, 'navigator', {
  value: {
    credentials: {
      create: mockCredentialsCreate,
      get:    mockCredentialsGet,
    },
  },
  writable:     true,
  configurable: true,
});

// ── crypto.getRandomValues mock ───────────────────────────────────────────────
Object.defineProperty(global, 'crypto', {
  value: {
    getRandomValues: jest.fn((arr: Uint8Array) => (arr.fill(42), arr)),
  },
  writable:     true,
  configurable: true,
});

const CONFIG = {
  factoryAddress:    'CFACTORY_ADDRESS',
  rpcUrl:            'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
};

function makeMockRegistrationCredential(id: string) {
  const rawKey = new Uint8Array(65).fill(4).buffer;
  return {
    id,
    type: 'public-key',
    response: {
      attestationObject:      new ArrayBuffer(32),
      clientDataJSON:         new ArrayBuffer(32),
      getPublicKey:           jest.fn(() => rawKey),
      getPublicKeyAlgorithm:  jest.fn(() => -7),
      getTransports:          jest.fn(() => ['internal']),
    },
  };
}

function makeMockAssertionCredential() {
  return {
    id:   'mock-id',
    type: 'public-key',
    response: {
      authenticatorData: new ArrayBuffer(37),
      clientDataJSON:    new ArrayBuffer(64),
      signature:         new ArrayBuffer(72),
      userHandle:        null,
    },
  };
}

describe('WebAuthn unicode normalization tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  it('NFC and NFD inputs converge to a deterministic credential ID and signing works', async () => {
    // "Amélie" in NFC
    const nameNFC = 'Am\u00e9lie';
    // "Amélie" in NFD
    const nameNFD = 'Ame\u0301lie';

    expect(nameNFC).not.toBe(nameNFD);
    expect(nameNFC.normalize('NFC')).toBe(nameNFD.normalize('NFC'));

    // We will track the user options passed to create
    const capturedUserOptions: any[] = [];
    mockCredentialsCreate.mockImplementation(async (options: any) => {
      capturedUserOptions.push(options.publicKey.user);
      return makeMockRegistrationCredential('deterministic-mock-credential-id');
    });

    const { result } = renderHook(() => useInvisibleWallet(CONFIG));

    // Register with NFC
    await act(async () => {
      await result.current.register(nameNFC);
    });

    // Register with NFD
    await act(async () => {
      await result.current.register(nameNFD);
    });

    // Check that both registrations resulted in the exact same `user.id` and `user.name` byte arrays / values
    expect(capturedUserOptions).toHaveLength(2);
    const [optionsNFC, optionsNFD] = capturedUserOptions;

    expect(optionsNFC.name).toBe(optionsNFD.name);
    expect(optionsNFC.displayName).toBe(optionsNFD.displayName);

    // Verify user ID buffer equality
    const userIdNFC = new Uint8Array(optionsNFC.id);
    const userIdNFD = new Uint8Array(optionsNFD.id);
    expect(userIdNFC).toEqual(userIdNFD);

    // Confirm signing works after registration
    mockCredentialsGet.mockResolvedValueOnce(makeMockAssertionCredential());
    const payload = new Uint8Array(32).fill(9);

    let sig: any;
    await act(async () => {
      sig = await result.current.signAuthEntry(payload);
    });

    expect(sig).not.toBeNull();
    expect(sig.signature).toBeInstanceOf(Uint8Array);
  }, 5000);
});
