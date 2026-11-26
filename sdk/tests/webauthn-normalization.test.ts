import { vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useInvisibleWallet } from '../src/useInvisibleWallet';

// ── @stellar/stellar-sdk mock ─────────────────────────────────────────────────
vi.mock('@stellar/stellar-sdk', () => ({
  Networks: {
    TESTNET: 'Test SDF Network ; September 2015',
    PUBLIC:  'Public Global Stellar Network ; September 2015',
  },
  BASE_FEE: '100',
  rpc: {
    Server: vi.fn().mockImplementation(() => ({
      getContractData:     vi.fn().mockResolvedValue({}),
      simulateTransaction: vi.fn().mockResolvedValue({
        result: { retval: {} },
        minResourceFee: '0',
        transactionData: {},
        events: [],
        latestLedger: 1,
      }),
      sendTransaction: vi.fn().mockResolvedValue({ status: 'PENDING', hash: 'mock-hash' }),
      getTransaction:  vi.fn().mockResolvedValue({ status: 'SUCCESS' }),
    })),
    Api: {
      GetTransactionStatus: { SUCCESS: 'SUCCESS', NOT_FOUND: 'NOT_FOUND', FAILED: 'FAILED' },
      isSimulationError: vi.fn(() => false),
    },
    Durability: { Persistent: 'persistent', Temporary: 'temporary' },
    assembleTransaction: vi.fn().mockReturnValue({
      build: vi.fn().mockReturnValue({ sign: vi.fn(), toXDR: vi.fn() }),
    }),
  },
  Horizon: {
    Server: vi.fn().mockImplementation(() => ({
      loadAccount: vi.fn().mockResolvedValue({
        balances: [],
        sequence: '0',
        account_id: 'GPUBKEY',
      }),
    })),
  },
  Account: vi.fn().mockImplementation((_id: string, seq: string) => ({
    accountId: () => _id,
    sequenceNumber: () => seq,
    incrementSequenceNumber: vi.fn(),
  })),
  Contract: vi.fn().mockImplementation(() => ({
    call: vi.fn().mockReturnValue({ toXDR: vi.fn() }),
  })),
  Keypair: {
    random:     vi.fn().mockReturnValue({ publicKey: () => 'GPUBKEY', secret: () => 'SSECRET' }),
    fromSecret: vi.fn().mockReturnValue({ publicKey: () => 'GPUBKEY', secret: () => 'SSECRET' }),
  },
  TransactionBuilder: vi.fn().mockImplementation(() => ({
    addOperation: vi.fn().mockReturnThis(),
    setTimeout:   vi.fn().mockReturnThis(),
    build:        vi.fn().mockReturnValue({ sign: vi.fn(), toXDR: vi.fn() }),
  })),
  StrKey: { isValidContract: vi.fn(() => true), isValidEd25519PublicKey: vi.fn(() => true) },
  xdr: {
    ScVal: { scvLedgerKeyContractInstance: vi.fn().mockReturnValue({}) },
  },
  nativeToScVal:  vi.fn().mockReturnValue({}),
  scValToNative:  vi.fn().mockReturnValue(BigInt(0)),
  Asset: {
    native: vi.fn().mockReturnValue({ contractId: vi.fn().mockReturnValue('CSAC') }),
  },
}));

// ── ./utils mock ──────────────────────────────────────────────────────────────
vi.mock('../src/utils', () => ({
  // Real round-tripping implementations (not fixed stubs): resolveUserId()
  // persists via bufferToHex and reads back via hexToUint8Array, so the two
  // must agree with each other across calls for the persistence test below.
  bufferToHex: vi.fn((input: Uint8Array | ArrayBuffer) => {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  }),
  hexToUint8Array: vi.fn((hex: string) => {
    const array = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) array[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    return array;
  }),
  derToRawSignature:    vi.fn(() => new Uint8Array(64).fill(1)),
  extractP256PublicKey: vi.fn().mockResolvedValue(new Uint8Array(65).fill(4)),
  computeWalletAddress: vi.fn(() => 'CWALLET_ADDRESS_MOCK'),
}));

// ── WebAuthn mock ─────────────────────────────────────────────────────────────
const mockCredentialsCreate = vi.fn();
const mockCredentialsGet    = vi.fn();

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
// Keep the real `subtle` implementation: the code under test imports ECDSA
// P-256 keys through it, and replacing the whole object with just
// `getRandomValues` left `subtle` undefined ("Cannot read properties of
// undefined (reading 'importKey')").
Object.defineProperty(global, 'crypto', {
  value: {
    getRandomValues: vi.fn((arr: Uint8Array) => (arr.fill(42), arr)),
    subtle:          global.crypto.subtle,
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
      getPublicKey:           vi.fn(() => rawKey),
      getPublicKeyAlgorithm:  vi.fn(() => -7),
      getTransports:          vi.fn(() => ['internal']),
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
    vi.clearAllMocks();
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

    // user.name still converges via NFC normalization of the display name.
    // user.id is independent of the username (persisted per-device, see
    // resolveUserId in useInvisibleWallet.ts) — it converges here because
    // both calls share the same storage, not because of Unicode normalization.
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
