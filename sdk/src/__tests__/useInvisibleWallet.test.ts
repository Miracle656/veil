/**
 * Unit tests for the useInvisibleWallet hook.
 *
 * WebAuthn browser APIs (navigator.credentials.create / .get) do not exist in
 * Node.js.  They are mocked here via jest.fn() so the tests run without a browser.
 * The Stellar SDK is also mocked so no real network calls are made.
 */

import { renderHook, act } from '@testing-library/react'
import { useInvisibleWallet } from '../useInvisibleWallet'
import { rpc as SorobanRpc } from '@stellar/stellar-sdk'

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
      payments: jest.fn().mockReturnValue({
        forAccount: jest.fn().mockReturnThis(),
        limit:      jest.fn().mockReturnThis(),
        order:      jest.fn().mockReturnThis(),
        call:       jest.fn().mockResolvedValue({ records: [] }),
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
}))

// ── ./utils mock ──────────────────────────────────────────────────────────────

jest.mock('../utils', () => ({
  bufferToHex:          jest.fn(() => 'aabbcc1122334455'),
  hexToUint8Array:      jest.fn(() => new Uint8Array(65).fill(4)),
  derToRawSignature:    jest.fn(() => new Uint8Array(64).fill(1)),
  extractP256PublicKey: jest.fn().mockResolvedValue(new Uint8Array(65).fill(4)),
  computeWalletAddress: jest.fn(() => 'CWALLET_ADDRESS_MOCK'),
}))

// ── WebAuthn mock ─────────────────────────────────────────────────────────────

const mockCredentialsCreate = jest.fn()
const mockCredentialsGet    = jest.fn()

Object.defineProperty(global, 'navigator', {
  value: {
    credentials: {
      create: mockCredentialsCreate,
      get:    mockCredentialsGet,
    },
  },
  writable:     true,
  configurable: true,
})

// ── crypto.getRandomValues mock ───────────────────────────────────────────────

Object.defineProperty(global, 'crypto', {
  value: {
    getRandomValues: jest.fn((arr: Uint8Array) => (arr.fill(42), arr)),
  },
  writable:     true,
  configurable: true,
})

// ── Helpers ───────────────────────────────────────────────────────────────────

const CONFIG = {
  factoryAddress:    'CFACTORY_ADDRESS',
  rpcUrl:            'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
}

/** A minimal PublicKeyCredential returned by navigator.credentials.create(). */
function makeMockRegistrationCredential() {
  const rawKey = new Uint8Array(65).fill(4).buffer
  return {
    id:   'bW9jay1jcmVkZW50aWFsLWlk',
    type: 'public-key',
    response: {
      attestationObject:      new ArrayBuffer(32),
      clientDataJSON:         new ArrayBuffer(32),
      getPublicKey:           jest.fn(() => rawKey),
      getPublicKeyAlgorithm:  jest.fn(() => -7),
      getTransports:          jest.fn(() => ['internal']),
    },
  }
}

/** A minimal PublicKeyCredential returned by navigator.credentials.get(). */
function makeMockAssertionCredential() {
  return {
    id:   'bW9jay1jcmVkZW50aWFsLWlk',
    type: 'public-key',
    response: {
      authenticatorData: new ArrayBuffer(37),
      clientDataJSON:    new ArrayBuffer(64),
      signature:         new ArrayBuffer(72),
      userHandle:        null,
    },
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useInvisibleWallet', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    localStorage.clear()

    // Reset SorobanRpc.Server to a fresh implementation for each test
    jest.mocked(SorobanRpc.Server).mockImplementation(
      () =>
        ({
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
        }) as any,
    )
  })

  // ── register() ─────────────────────────────────────────────────────────────

  describe('register()', () => {
    it('creates a passkey credential and returns the deterministic wallet address', async () => {
      mockCredentialsCreate.mockResolvedValueOnce(makeMockRegistrationCredential())

      const { result } = renderHook(() => useInvisibleWallet(CONFIG))

      let registerResult: Awaited<ReturnType<typeof result.current.register>>
      await act(async () => {
        registerResult = await result.current.register('alice')
      })

      expect(mockCredentialsCreate).toHaveBeenCalledTimes(1)
      expect(registerResult!.walletAddress).toBe('CWALLET_ADDRESS_MOCK')
      expect(result.current.address).toBe('CWALLET_ADDRESS_MOCK')
      expect(result.current.isPending).toBe(false)
      expect(result.current.error).toBeNull()
    })

    it('stores credential id, public key, and address in localStorage', async () => {
      mockCredentialsCreate.mockResolvedValueOnce(makeMockRegistrationCredential())

      const { result } = renderHook(() => useInvisibleWallet(CONFIG))
      await act(async () => { await result.current.register('bob') })

      expect(localStorage.getItem('invisible_wallet_address')).toBe('CWALLET_ADDRESS_MOCK')
      expect(localStorage.getItem('invisible_wallet_key_id')).not.toBeNull()
      expect(localStorage.getItem('invisible_wallet_public_key')).not.toBeNull()
    })

    it('sets error state and re-throws when passkey creation is cancelled', async () => {
      mockCredentialsCreate.mockRejectedValueOnce(new Error('NotAllowedError: operation cancelled'))

      const { result } = renderHook(() => useInvisibleWallet(CONFIG))

      // Capture the rejection inside act() to flush React state updates
      let caughtError: Error | null = null
      await act(async () => {
        try {
          await result.current.register()
        } catch (e) {
          caughtError = e as Error
        }
      })

      expect(caughtError).not.toBeNull()
      expect(caughtError!.message).toContain('NotAllowedError')
      expect(result.current.error).toContain('NotAllowedError')
      expect(result.current.isPending).toBe(false)
    })

    it('throws when navigator.credentials is unavailable (no WebAuthn support)', async () => {
      const savedCredentials = (global.navigator as any).credentials
      Object.defineProperty(global.navigator, 'credentials', {
        value:        undefined,
        writable:     true,
        configurable: true,
      })

      const { result } = renderHook(() => useInvisibleWallet(CONFIG))
      await act(async () => {
        await expect(result.current.register()).rejects.toThrow()
      })

      expect(result.current.error).not.toBeNull()

      // Restore
      Object.defineProperty(global.navigator, 'credentials', {
        value:        savedCredentials,
        writable:     true,
        configurable: true,
      })
    })
  })

  // ── login() ────────────────────────────────────────────────────────────────

  describe('login()', () => {
    it('returns null and sets an error when no wallet address is stored', async () => {
      const { result } = renderHook(() => useInvisibleWallet(CONFIG))

      let loginResult!: Awaited<ReturnType<typeof result.current.login>>
      await act(async () => { loginResult = await result.current.login() })

      expect(loginResult).toBeNull()
      expect(result.current.error).toContain('No wallet found')
      expect(result.current.isDeployed).toBe(false)
    })

    it('restores the session and marks the wallet deployed when the contract exists on-chain', async () => {
      localStorage.setItem('invisible_wallet_address', 'CEXISTING_WALLET')

      // getContractData resolves → contract found
      jest.mocked(SorobanRpc.Server).mockImplementation(
        () => ({ getContractData: jest.fn().mockResolvedValue({}) }) as any,
      )

      const { result } = renderHook(() => useInvisibleWallet(CONFIG))

      let loginResult!: Awaited<ReturnType<typeof result.current.login>>
      await act(async () => { loginResult = await result.current.login() })

      expect(loginResult).toEqual({ walletAddress: 'CEXISTING_WALLET' })
      expect(result.current.address).toBe('CEXISTING_WALLET')
      expect(result.current.isDeployed).toBe(true)
      expect(result.current.error).toBeNull()
    })

    it('returns null when the contract address exists in storage but is not yet deployed on-chain', async () => {
      localStorage.setItem('invisible_wallet_address', 'CNOT_DEPLOYED_YET')

      jest.mocked(SorobanRpc.Server).mockImplementation(
        () =>
          ({
            getContractData: jest.fn().mockRejectedValue(new Error('contract not found')),
          }) as any,
      )

      const { result } = renderHook(() => useInvisibleWallet(CONFIG))

      let loginResult!: Awaited<ReturnType<typeof result.current.login>>
      await act(async () => { loginResult = await result.current.login() })

      expect(loginResult).toBeNull()
      expect(result.current.isDeployed).toBe(false)
      expect(result.current.error).toContain('not yet deployed')
    })
  })

  // ── signAuthEntry() ────────────────────────────────────────────────────────

  describe('signAuthEntry()', () => {
    beforeEach(() => {
      localStorage.setItem('invisible_wallet_key_id', 'bW9jay1jcmVkZW50aWFsLWlk')
      localStorage.setItem('invisible_wallet_public_key', 'aabbcc')
    })

    it('returns a WebAuthnSignature when the assertion succeeds', async () => {
      mockCredentialsGet.mockResolvedValueOnce(makeMockAssertionCredential())

      const { result } = renderHook(() => useInvisibleWallet(CONFIG))
      const payload = new Uint8Array(32).fill(9)

      let sig!: Awaited<ReturnType<typeof result.current.signAuthEntry>>
      await act(async () => { sig = await result.current.signAuthEntry(payload) })

      expect(sig).not.toBeNull()
      expect(sig!.publicKey).toBeInstanceOf(Uint8Array)
      expect(sig!.authData).toBeInstanceOf(Uint8Array)
      expect(sig!.clientDataJSON).toBeInstanceOf(Uint8Array)
      expect(sig!.signature).toBeInstanceOf(Uint8Array)
    })

    it('returns null and sets an error when the payload is not 32 bytes', async () => {
      const { result } = renderHook(() => useInvisibleWallet(CONFIG))
      const badPayload = new Uint8Array(16)

      let sig!: Awaited<ReturnType<typeof result.current.signAuthEntry>>
      await act(async () => { sig = await result.current.signAuthEntry(badPayload) })

      expect(sig).toBeNull()
      expect(result.current.error).toContain('32 bytes')
    })

    it('returns null and sets an error when no key ID is stored (not yet registered)', async () => {
      localStorage.removeItem('invisible_wallet_key_id')

      const { result } = renderHook(() => useInvisibleWallet(CONFIG))
      const payload = new Uint8Array(32).fill(1)

      let sig!: Awaited<ReturnType<typeof result.current.signAuthEntry>>
      await act(async () => { sig = await result.current.signAuthEntry(payload) })

      expect(sig).toBeNull()
      expect(result.current.error).toMatch(/No key ID/)
    })
  })

  // ── initial state ──────────────────────────────────────────────────────────

  describe('initial state', () => {
    it('picks up a stored wallet address from localStorage on mount', () => {
      localStorage.setItem('invisible_wallet_address', 'CPRESTORED')

      const { result } = renderHook(() => useInvisibleWallet(CONFIG))

      // useEffect runs asynchronously — use act to flush it
      act(() => {})
      expect(result.current.address).toBe('CPRESTORED')
    })

    it('starts with isPending=false and error=null', () => {
      const { result } = renderHook(() => useInvisibleWallet(CONFIG))
      expect(result.current.isPending).toBe(false)
      expect(result.current.error).toBeNull()
    })
  })
})
