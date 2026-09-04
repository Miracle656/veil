/**
 * Snapshot test for the serialized passkey credential format (v1).
 *
 * The credential fields written to localStorage by register() must remain
 * stable so existing wallets keep working after SDK upgrades. This test
 * deserializes the v1 fixture and confirms the SDK still recognises every field.
 *
 * Format stability policy
 * -----------------------
 * - Storage keys are frozen: any rename is a breaking change requiring a
 *   migration shim.
 * - `invisible_wallet_public_key` is always an uncompressed P-256 key: 65
 *   bytes encoded as a 130-character lowercase hex string, prefix byte 0x04.
 * - `invisible_wallet_key_id` is a base64url string (no padding required).
 * - `invisible_wallet_address` is a 56-character Stellar contract Strkey
 *   beginning with "C".
 * - If a new field must be added, it must be optional so v1 credentials
 *   without it continue to load. Bump this comment and the fixture version
 *   label when the format changes.
 */

import fixtureV1 from './fixtures/credential-v1.json';
import { hexToUint8Array } from '../src/utils';
import { renderHook, act } from '@testing-library/react';
import { useInvisibleWallet } from '../src/useInvisibleWallet';

// ── @stellar/stellar-sdk mock ──────────────────────────────────────────────────
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
  StrKey: {
    isValidContract:          jest.fn(() => true),
    isValidEd25519PublicKey:  jest.fn(() => true),
  },
  xdr: {
    ScVal: { scvLedgerKeyContractInstance: jest.fn().mockReturnValue({}) },
  },
  nativeToScVal:  jest.fn().mockReturnValue({}),
  scValToNative:  jest.fn().mockReturnValue(BigInt(0)),
  Asset: {
    native: jest.fn().mockReturnValue({ contractId: jest.fn().mockReturnValue('CSAC') }),
  },
  hash: jest.fn().mockReturnValue(Buffer.alloc(32)),
}));

// ── WebAuthn mock ──────────────────────────────────────────────────────────────
const mockCredentialsGet = jest.fn();
Object.defineProperty(global, 'navigator', {
  value: { credentials: { create: jest.fn(), get: mockCredentialsGet } },
  writable: true,
  configurable: true,
});

const CONFIG = {
  factoryAddress:    'CFACTORY_ADDRESS_MOCK_FOR_TESTS',
  rpcUrl:            'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
};

function makeStorageAdapter(seed: Record<string, string>) {
  const store = new Map(Object.entries(seed));
  return {
    getItem:    (k: string) => store.get(k) ?? null,
    setItem:    (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
}

// ── Fixture schema ─────────────────────────────────────────────────────────────

describe('credential-format v1 — fixture schema', () => {
  it('storage keys match snapshot', () => {
    expect(Object.keys(fixtureV1).sort()).toMatchSnapshot();
  });

  it('public key is 130-char hex (65 bytes uncompressed P-256)', () => {
    const hex = fixtureV1['invisible_wallet_public_key'];
    expect(hex).toHaveLength(130);
    expect(hex.slice(0, 2)).toBe('04');
    expect(hex).toMatch(/^[0-9a-f]+$/);
  });

  it('credential ID is a non-empty base64url string', () => {
    const id = fixtureV1['invisible_wallet_key_id'];
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(id).toMatch(/^[A-Za-z0-9_=-]+$/);
  });

  it('wallet address is a 56-char Stellar contract Strkey starting with C', () => {
    const addr = fixtureV1['invisible_wallet_address'];
    expect(addr).toHaveLength(56);
    expect(addr[0]).toBe('C');
  });

  it('full fixture matches snapshot', () => {
    expect(fixtureV1).toMatchSnapshot();
  });
});

// ── Deserialization ────────────────────────────────────────────────────────────

describe('credential-format v1 — deserialization', () => {
  it('hexToUint8Array round-trips the stored public key', () => {
    const hex   = fixtureV1['invisible_wallet_public_key'];
    const bytes = hexToUint8Array(hex);
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(0x04);
    expect(bytes).toMatchSnapshot();
  });

  it('hook reads v1 credential from storage without throwing', async () => {
    const storage = makeStorageAdapter(fixtureV1 as Record<string, string>);

    // Build a minimal valid DER-encoded ECDSA signature: SEQUENCE { INTEGER r, INTEGER s }
    const r = new Uint8Array(32).fill(0x01);
    const s = new Uint8Array(32).fill(0x02);
    const derSig = new Uint8Array([0x30, 0x44, 0x02, 0x20, ...r, 0x02, 0x20, ...s]);

    mockCredentialsGet.mockResolvedValueOnce({
      id:   fixtureV1['invisible_wallet_key_id'],
      type: 'public-key',
      response: {
        authenticatorData: new ArrayBuffer(37),
        clientDataJSON:    new ArrayBuffer(64),
        signature:         derSig.buffer,
        userHandle:        null,
      },
    });

    const { result } = renderHook(() =>
      useInvisibleWallet({ ...CONFIG, storage })
    );

    const payload = new Uint8Array(32).fill(1);
    let sig: unknown;
    await act(async () => {
      sig = await result.current.signAuthEntry(payload);
    });

    expect(sig).not.toBeNull();
  });
});
