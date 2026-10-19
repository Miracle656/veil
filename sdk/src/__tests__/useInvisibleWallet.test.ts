/**
 * Unit tests for the useInvisibleWallet hook.
 *
 * WebAuthn browser APIs (navigator.credentials.create / .get) do not exist in
 * Node.js.  They are mocked here via jest.fn() so the tests run without a browser.
 * The Stellar SDK is also mocked so no real network calls are made.
 */

import { renderHook, act } from '@testing-library/react'
import { useInvisibleWallet } from '../useInvisibleWallet'
import { computeWalletAddress } from '../utils'
import { recoverAssertionPublicKeys } from '../crypto/assertionKey'
import { rpc as SorobanRpc, TransactionBuilder, Keypair } from '@stellar/stellar-sdk'

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
      getAccount:      jest.fn().mockResolvedValue({
        accountId: () => 'GPUBKEY',
        sequenceNumber: () => '0',
        incrementSequenceNumber: jest.fn(),
      }),
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
  TransactionBuilder: Object.assign(
    jest.fn().mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout:   jest.fn().mockReturnThis(),
      build:        jest.fn().mockReturnValue({ sign: jest.fn(), toXDR: jest.fn() }),
    })),
    {
      buildFeeBumpTransaction: jest.fn().mockReturnValue({
        sign:  jest.fn(),
        toXDR: jest.fn(),
      }),
    },
  ),
  StrKey: { isValidContract: jest.fn(() => true), isValidEd25519PublicKey: jest.fn(() => true) },
  xdr: {
    ScVal: { scvLedgerKeyContractInstance: jest.fn().mockReturnValue({}) },
  },
  // Real SHA-256, so crypto/assertionKey.ts can hash a genuine assertion.
  hash: (input: Buffer) => require('crypto').createHash('sha256').update(input).digest(),
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

// The webauthn module mock must be at the top level so that core.ts picks up
// the mocked webAuthnProvider when it first imports the module.
jest.mock('../webauthn', () => {
  const actual = jest.requireActual('../webauthn');
  return {
    ...actual,
    webAuthnProvider: {
      ...actual.webAuthnProvider,
      authenticate: jest.fn(),
    },
  };
});

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

// ── A genuine assertion, for the key-recovery path ────────────────────────────
//
// login({ credentialId }) can only resolve a wallet if it can work out which
// passkey signed, and an assertion carries no public key. These fixtures make a
// real P-256 key sign a real WebAuthn payload, so the test exercises actual
// recovery instead of a stubbed key — the exact case React Native is in.

const nodeCrypto = require('crypto')

/** A real P-256 key pair, public half in the SDK's 0x04 ‖ x ‖ y form. */
function makeRealPasskey() {
  const pair = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = new Uint8Array(pair.publicKey.export({ type: 'spki', format: 'der' }))
  return { privateKey: pair.privateKey, publicKeyBytes: spki.slice(spki.length - 65) }
}

/** The three bytes an authenticator would return — deliberately no public key. */
function makeRealAssertion(privateKey: unknown, seed: number) {
  const authData = new Uint8Array(37)
  authData[32] = 0x45
  const clientDataJSON = new Uint8Array(64)
  for (let i = 0; i < clientDataJSON.length; i++) clientDataJSON[i] = (i * 13 + seed) & 0xff

  const clientDataHash = nodeCrypto.createHash('sha256').update(Buffer.from(clientDataJSON)).digest()
  const verificationData = Buffer.concat([Buffer.from(authData), clientDataHash])
  const signature = new Uint8Array(
    nodeCrypto.sign('sha256', verificationData, { key: privateKey, dsaEncoding: 'ieee-p1363' })
  )
  return { authData, clientDataJSON, signature }
}

/**
 * Stand-in for computeWalletAddress: an address that names the key it came from,
 * so a test can tell which candidate the SDK actually derived.
 */
function addressForKey(publicKeyBytes: Uint8Array): string {
  return `C${Buffer.from(publicKeyBytes).toString('hex').slice(0, 55).toUpperCase()}`
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

    // mockImplementation survives clearAllMocks, so a test that maps keys to
    // addresses must not leak that into the next one: restore the default.
    jest.mocked(computeWalletAddress).mockImplementation(() => 'CWALLET_ADDRESS_MOCK')
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

    it('does not derive user.id from the supplied username', async () => {
      mockCredentialsCreate.mockResolvedValueOnce(makeMockRegistrationCredential())

      const { result } = renderHook(() => useInvisibleWallet(CONFIG))
      await act(async () => { await result.current.register('Veil wallet') })

      const passedOptions = mockCredentialsCreate.mock.calls[0][0].publicKey
      const userIdBytes = new Uint8Array(passedOptions.user.id)
      const usernameBytes = new TextEncoder().encode('Veil wallet')

      expect(userIdBytes).not.toEqual(usernameBytes)
    })

    it('omits excludeCredentials on a first-ever registration', async () => {
      mockCredentialsCreate.mockResolvedValueOnce(makeMockRegistrationCredential())

      const { result } = renderHook(() => useInvisibleWallet(CONFIG))
      await act(async () => { await result.current.register('alice') })

      const passedOptions = mockCredentialsCreate.mock.calls[0][0].publicKey
      expect(passedOptions.excludeCredentials ?? []).toHaveLength(0)
    })

    it('passes the existing credential id as excludeCredentials on a repeat registration, guarding against silent overwrite', async () => {
      mockCredentialsCreate.mockResolvedValueOnce(makeMockRegistrationCredential())
      mockCredentialsCreate.mockResolvedValueOnce(makeMockRegistrationCredential())

      const { result } = renderHook(() => useInvisibleWallet(CONFIG))

      // First registration for this wallet/storage.
      await act(async () => { await result.current.register('Veil wallet') })
      const firstKeyId = localStorage.getItem('invisible_wallet_key_id')
      expect(firstKeyId).not.toBeNull()

      // A second registration attempt on the same device/storage — e.g. someone
      // else typing the same display name — must exclude the credential already
      // enrolled here so the authenticator refuses rather than silently
      // replacing it (issue #627).
      await act(async () => { await result.current.register('Veil wallet') })

      const secondOptions = mockCredentialsCreate.mock.calls[1][0].publicKey
      expect(secondOptions.excludeCredentials).toBeDefined()
      const excludedIds = secondOptions.excludeCredentials.map((c: { id: ArrayBuffer }) => Buffer.from(c.id).toString('base64'))
      expect(excludedIds.length).toBeGreaterThan(0)
    })
  })

  // ── login() ────────────────────────────────────────────────────────────────

  describe('login()', () => {
    it('returns null and sets an error when no wallet address is stored and no options', async () => {
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

    it('accepts a walletAddress option and verifies on-chain when no local address is stored', async () => {
      jest.mocked(SorobanRpc.Server).mockImplementation(
        () => ({ getContractData: jest.fn().mockResolvedValue({}) }) as any,
      )

      const { result } = renderHook(() => useInvisibleWallet(CONFIG))

      let loginResult!: Awaited<ReturnType<typeof result.current.login>>
      await act(async () => {
        loginResult = await result.current.login({ walletAddress: 'CKNOWN_WALLET' })
      })

      expect(loginResult).toEqual({ walletAddress: 'CKNOWN_WALLET' })
      expect(result.current.address).toBe('CKNOWN_WALLET')
      expect(result.current.isDeployed).toBe(true)
      // Should persist for subsequent calls
      expect(localStorage.getItem('invisible_wallet_address')).toBe('CKNOWN_WALLET')
    })

    it('returns null when walletAddress option points to a contract not deployed on-chain', async () => {
      jest.mocked(SorobanRpc.Server).mockImplementation(
        () => ({
          getContractData: jest.fn().mockRejectedValue(new Error('contract not found')),
        }) as any,
      )

      const { result } = renderHook(() => useInvisibleWallet(CONFIG))

      let loginResult!: Awaited<ReturnType<typeof result.current.login>>
      await act(async () => {
        loginResult = await result.current.login({ walletAddress: 'CNOT_DEPLOYED' })
      })

      expect(loginResult).toBeNull()
      expect(result.current.isDeployed).toBe(false)
      expect(result.current.error).toContain('not yet deployed')
    })

    it('recovers the passkey public key from an assertion that carries none (the React Native shape)', async () => {
      // react-native-passkey's authenticate() returns authData, clientDataJSON and
      // signature — and no public key, because WebAuthn assertions do not have one.
      // Before recovery existed this branch silently did nothing on mobile.
      const { webAuthnProvider } = require('../webauthn');
      const { privateKey, publicKeyBytes } = makeRealPasskey();
      const assertion = makeRealAssertion(privateKey, 3);

      jest.mocked(webAuthnProvider.authenticate).mockResolvedValue({
        ...assertion,
        publicKeyBytes: null,
      });
      jest.mocked(computeWalletAddress).mockImplementation(
        (_factory: string, key: Uint8Array) => addressForKey(key)
      );

      const expectedAddress = addressForKey(publicKeyBytes);
      const getContractData = jest.fn(async (address: string) => {
        if (address !== expectedAddress) throw new Error('contract not found');
        return {};
      });
      jest.mocked(SorobanRpc.Server).mockImplementation(() => ({ getContractData }) as any);

      const { result } = renderHook(() => useInvisibleWallet(CONFIG));

      let loginResult!: Awaited<ReturnType<typeof result.current.login>>
      await act(async () => {
        loginResult = await result.current.login({ credentialId: 'bW9jay1jcmVkZW50aWFsLWlk' })
      })

      // The wallet that is really deployed — i.e. the key that really signed.
      expect(loginResult).toEqual({ walletAddress: expectedAddress });
      expect(result.current.address).toBe(expectedAddress);
      expect(result.current.isDeployed).toBe(true);
    });

    it('tries every recovered candidate and adopts only the deployed one', async () => {
      // An assertion signature has no recovery id, so two keys verify it and
      // recovery cannot say which signed. Which position the real key lands in
      // depends on the nonce's parity, so build a fixture where it is the SECOND
      // candidate — that forces the chain check to reject one address and move on.
      const { webAuthnProvider } = require('../webauthn');

      let deployedKey: Uint8Array | undefined;
      let assertion: ReturnType<typeof makeRealAssertion> | undefined;
      for (let attempt = 0; attempt < 24 && !deployedKey; attempt++) {
        const { privateKey, publicKeyBytes } = makeRealPasskey();
        const candidate = makeRealAssertion(privateKey, attempt);
        const recovered = recoverAssertionPublicKeys(candidate);
        if (recovered.length === 2 && Buffer.from(recovered[1]).equals(Buffer.from(publicKeyBytes))) {
            deployedKey = publicKeyBytes;
            assertion = candidate;
        }
      }
      if (!deployedKey || !assertion) throw new Error('Fixture: no assertion put the real key second');

      jest.mocked(webAuthnProvider.authenticate).mockResolvedValue({
        ...assertion,
        publicKeyBytes: null,
      });
      jest.mocked(computeWalletAddress).mockImplementation(
        (_factory: string, key: Uint8Array) => addressForKey(key)
      );

      const deployedAddress = addressForKey(deployedKey);
      const lookedUp: string[] = [];
      const getContractData = jest.fn(async (address: string) => {
        lookedUp.push(address);
        if (address !== deployedAddress) throw new Error('contract not found');
        return {};
      });
      jest.mocked(SorobanRpc.Server).mockImplementation(() => ({ getContractData }) as any);

      const { result } = renderHook(() => useInvisibleWallet(CONFIG));

      let loginResult!: Awaited<ReturnType<typeof result.current.login>>
      await act(async () => {
        loginResult = await result.current.login({ credentialId: 'bW9jay1jcmVkZW50aWFsLWlk' })
      });

      // The bogus candidate was queried, rejected, and then the real one found.
      expect(lookedUp).toHaveLength(2);
      expect(lookedUp[1]).toBe(deployedAddress);
      expect(lookedUp[0]).not.toBe(deployedAddress);
      expect(loginResult).toEqual({ walletAddress: deployedAddress });
      // Nothing was ever persisted for the candidate the chain rejected.
      expect(localStorage.getItem('invisible_wallet_address')).toBe(deployedAddress);
    });

    it('reports a wallet that is not yet deployed when no candidate resolves', async () => {
      const { webAuthnProvider } = require('../webauthn');
      const { privateKey } = makeRealPasskey();

      jest.mocked(webAuthnProvider.authenticate).mockResolvedValue({
        ...makeRealAssertion(privateKey, 21),
        publicKeyBytes: null,
      });
      jest.mocked(computeWalletAddress).mockImplementation(
        (_factory: string, key: Uint8Array) => addressForKey(key)
      );
      jest.mocked(SorobanRpc.Server).mockImplementation(
        () => ({
          getContractData: jest.fn().mockRejectedValue(new Error('contract not found')),
        }) as any,
      );

      const { result } = renderHook(() => useInvisibleWallet(CONFIG));

      let loginResult!: Awaited<ReturnType<typeof result.current.login>>
      await act(async () => {
        loginResult = await result.current.login({ credentialId: 'bW9jay1jcmVkZW50aWFsLWlk' })
      })

      expect(loginResult).toBeNull();
      expect(result.current.address).toBeNull();
      expect(result.current.error).toContain('not yet deployed');
      expect(localStorage.getItem('invisible_wallet_address')).toBeNull();
    });

    it('derives nothing when the assertion recovers no key at all', async () => {
      // A signature that is not a valid P-256 signature has no signing key to
      // find, so login must say "no wallet" rather than guess one.
      const { webAuthnProvider } = require('../webauthn');

      jest.mocked(webAuthnProvider.authenticate).mockResolvedValue({
        authData:       new Uint8Array(37),
        clientDataJSON: new Uint8Array(64),
        signature:      new Uint8Array(64).fill(1),
        publicKeyBytes: null,
      });
      const getContractData = jest.fn().mockResolvedValue({});
      jest.mocked(SorobanRpc.Server).mockImplementation(() => ({ getContractData }) as any);

      const { result } = renderHook(() => useInvisibleWallet(CONFIG));

      let loginResult!: Awaited<ReturnType<typeof result.current.login>>
      await act(async () => {
        loginResult = await result.current.login({ credentialId: 'bW9jay1jcmVkZW50aWFsLWlk' })
      })

      expect(loginResult).toBeNull();
      expect(result.current.error).toContain('No wallet found');
      // Nothing was invented, so nothing was looked up.
      expect(getContractData).not.toHaveBeenCalled();
    });

    it('still prefers a public key the platform did report, before recovering', async () => {
      // Some environments do surface a key on the assertion. It is the same key
      // recovery would find, so using it first just skips a chain lookup — and on
      // every other platform the recovered candidates follow in the same list.
      const { webAuthnProvider } = require('../webauthn');
      const reportedKey = new Uint8Array(65).fill(4);
      const { privateKey } = makeRealPasskey();

      jest.mocked(webAuthnProvider.authenticate).mockResolvedValue({
        ...makeRealAssertion(privateKey, 31),
        publicKeyBytes: reportedKey,
      });
      jest.mocked(computeWalletAddress).mockImplementation(
        (_factory: string, key: Uint8Array) => addressForKey(key)
      );

      const lookedUp: string[] = [];
      const getContractData = jest.fn(async (address: string) => {
        lookedUp.push(address);
        if (address !== addressForKey(reportedKey)) throw new Error('contract not found');
        return {};
      });
      jest.mocked(SorobanRpc.Server).mockImplementation(() => ({ getContractData }) as any);

      const { result } = renderHook(() => useInvisibleWallet(CONFIG));

      let loginResult!: Awaited<ReturnType<typeof result.current.login>>
      await act(async () => {
        loginResult = await result.current.login({ credentialId: 'bW9jay1jcmVkZW50aWFsLWlk' })
      })

      expect(loginResult).toEqual({ walletAddress: addressForKey(reportedKey) });
      expect(lookedUp[0]).toBe(addressForKey(reportedKey));
    });
  })

  // ── deploy() ───────────────────────────────────────────────────────────────

  // NOTE: these cases deliberately use the DEPRECATED secret/Keypair inputs to
  // cover the migration path; the callback path is covered in signer.test.ts.
  describe('deploy()', () => {
    it('builds a single-operation Soroban deploy transaction when sponsored', async () => {
      const { result } = renderHook(() => useInvisibleWallet({
        ...CONFIG,
        sponsorSecret: 'SSPONSOR',
      }))

      let deployResult!: Awaited<ReturnType<typeof result.current.deploy>>
      await act(async () => {
        deployResult = await result.current.deploy('SUSER', new Uint8Array(65).fill(4))
      })

      const txBuilderMock = TransactionBuilder as unknown as jest.Mock
      const deployBuilder = txBuilderMock.mock.results[0].value as any
      expect(deployBuilder.addOperation).toHaveBeenCalledTimes(1)
      expect(TransactionBuilder.buildFeeBumpTransaction).toHaveBeenCalledTimes(1)
      expect(deployResult.walletAddress).toBe('CWALLET_ADDRESS_MOCK')
      expect(deployResult.alreadyDeployed).toBe(false)
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

    it('throws when the payload is not 32 bytes', async () => {
      const { result } = renderHook(() => useInvisibleWallet(CONFIG))
      const badPayload = new Uint8Array(16)

      await expect(
        act(async () => { await result.current.signAuthEntry(badPayload) })
      ).rejects.toThrow('32 bytes')
    })

    it('throws when no key ID is stored (not yet registered)', async () => {
      localStorage.removeItem('invisible_wallet_key_id')

      const { result } = renderHook(() => useInvisibleWallet(CONFIG))
      const payload = new Uint8Array(32).fill(1)

      await expect(
        act(async () => { await result.current.signAuthEntry(payload) })
      ).rejects.toThrow(/No key ID/)
    })
  })

  // ── rotateSigner() ───────────────────────────────────────────────────────────

  describe('rotateSigner()', () => {
    beforeEach(() => {
      localStorage.setItem('invisible_wallet_address', 'CEXISTING_WALLET')
      localStorage.setItem('invisible_wallet_public_key', 'aabbcc')
      localStorage.setItem('invisible_wallet_key_id', 'bW9jay1jcmVkZW50aWFsLWlk')

      // The default Server mock lacks getAccount, which rotateSigner needs.
      jest.mocked(SorobanRpc.Server).mockImplementation(
        () =>
          ({
            getAccount: jest.fn().mockResolvedValue({
              accountId:      () => 'GPUBKEY',
              sequenceNumber: () => '0',
            }),
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

    it('registers a new credential, preserves the wallet address, and stores the new key', async () => {
      mockCredentialsCreate.mockResolvedValueOnce(makeMockRegistrationCredential())

      const { result } = renderHook(() => useInvisibleWallet(CONFIG))
      await act(async () => {}) // flush mount effect so the stored address is picked up

      const keypair = Keypair.fromSecret('SUSER')

      let rotateResult!: Awaited<ReturnType<typeof result.current.rotateSigner>>
      await act(async () => {
        rotateResult = await result.current.rotateSigner(keypair as any, 'new-device')
      })

      // A brand-new WebAuthn credential was registered.
      expect(mockCredentialsCreate).toHaveBeenCalledTimes(1)
      // The wallet address (and therefore balances) is unchanged.
      expect(rotateResult.walletAddress).toBe('CEXISTING_WALLET')
      expect(result.current.address).toBe('CEXISTING_WALLET')
      // A new 65-byte uncompressed P-256 key was produced.
      expect(rotateResult.newPublicKeyBytes).toHaveLength(65)
      // Storage now holds the new public key, not the old one.
      expect(localStorage.getItem('invisible_wallet_public_key')).not.toBe('aabbcc')
      expect(result.current.error).toBeNull()
    })

    it('throws when there is no existing public key in storage', async () => {
      localStorage.removeItem('invisible_wallet_public_key')
      mockCredentialsCreate.mockResolvedValueOnce(makeMockRegistrationCredential())

      const { result } = renderHook(() => useInvisibleWallet(CONFIG))
      await act(async () => {})

      const keypair = Keypair.fromSecret('SUSER')
      await expect(
        act(async () => { await result.current.rotateSigner(keypair as any) })
      ).rejects.toThrow(/No existing public key/)
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

  describe('addSigner()', () => {
    it('submits add_signer and returns signerIndex decoded from tx returnValue', async () => {
      localStorage.setItem('invisible_wallet_address', 'CWALLET')
      const { result } = renderHook(() => useInvisibleWallet(CONFIG))

      // Make scValToNative return index 2 for this call
      ;(SorobanRpc.Server as jest.Mock).mockImplementationOnce(() => ({
        getAccount:      jest.fn().mockResolvedValue({ accountId: () => 'G', sequenceNumber: () => '0', incrementSequenceNumber: jest.fn() }),
        simulateTransaction: jest.fn().mockResolvedValue({ result: { retval: {} }, minResourceFee: '0', transactionData: {}, events: [], latestLedger: 1 }),
        sendTransaction: jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'add-hash' }),
        getTransaction:  jest.fn().mockResolvedValue({ status: 'SUCCESS', returnValue: { _type: 'u32', _value: 2 } }),
      }))

      const { scValToNative } = jest.requireMock('@stellar/stellar-sdk') as typeof import('@stellar/stellar-sdk')
      ;(scValToNative as jest.Mock).mockReturnValueOnce(2)

      const fakeKeypair = Keypair.fromSecret('SSECRET')
      const newKey = new Uint8Array(65).fill(4)

      let res!: Awaited<ReturnType<typeof result.current.addSigner>>
      await act(async () => {
        res = await result.current.addSigner(fakeKeypair, newKey)
      })

      expect(res.signerIndex).toBe(2)
    })

    it('throws when newPublicKeyBytes is not 65 bytes', async () => {
      localStorage.setItem('invisible_wallet_address', 'CWALLET')
      const { result } = renderHook(() => useInvisibleWallet(CONFIG))

      await act(async () => {
        await expect(
          result.current.addSigner(Keypair.fromSecret('SSECRET'), new Uint8Array(32))
        ).rejects.toThrow('newPublicKeyBytes must be exactly 65 bytes')
      })
    })

    it('throws when no wallet address is set', async () => {
      localStorage.removeItem('invisible_wallet_address')
      const { result } = renderHook(() => useInvisibleWallet(CONFIG))

      await act(async () => {
        await expect(
          result.current.addSigner(Keypair.fromSecret('SSECRET'), new Uint8Array(65))
        ).rejects.toThrow('No wallet address')
      })
    })
  })

  describe('removeSigner()', () => {
    it('submits remove_signer and resolves on success', async () => {
      localStorage.setItem('invisible_wallet_address', 'CWALLET')

      ;(SorobanRpc.Server as jest.Mock).mockImplementationOnce(() => ({
        getAccount:          jest.fn().mockResolvedValue({ accountId: () => 'G', sequenceNumber: () => '0', incrementSequenceNumber: jest.fn() }),
        simulateTransaction: jest.fn().mockResolvedValue({ result: { retval: {} }, minResourceFee: '0', transactionData: {}, events: [], latestLedger: 1 }),
        sendTransaction:     jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'rm-hash' }),
        getTransaction:      jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
      }))

      const { result } = renderHook(() => useInvisibleWallet(CONFIG))

      await act(async () => {
        await expect(
          result.current.removeSigner(Keypair.fromSecret('SSECRET'), 1)
        ).resolves.toBeUndefined()
      })
    })

    it('throws when no wallet address is set', async () => {
      localStorage.removeItem('invisible_wallet_address')
      const { result } = renderHook(() => useInvisibleWallet(CONFIG))

      await act(async () => {
        await expect(
          result.current.removeSigner(Keypair.fromSecret('SSECRET'), 0)
        ).rejects.toThrow('No wallet address')
      })
    })
  })

  describe('getSigners()', () => {
    it('returns SignerInfo array sorted by index', async () => {
      localStorage.setItem('invisible_wallet_address', 'CWALLET')

      // Simulate a Map returned by scValToNative via the object-entries fallback path
      const fakeSignersObj: Record<string, Uint8Array> = {
        '1': new Uint8Array(65).fill(9),
        '0': new Uint8Array(65).fill(4),
      }

      ;(SorobanRpc.Server as jest.Mock).mockImplementationOnce(() => ({
        getAccount:          jest.fn().mockResolvedValue({ accountId: () => 'G', sequenceNumber: () => '0', incrementSequenceNumber: jest.fn() }),
        simulateTransaction: jest.fn().mockResolvedValue({ result: { retval: { _fake: true } }, minResourceFee: '0', transactionData: {}, events: [], latestLedger: 1 }),
        sendTransaction:     jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'sig-hash' }),
        getTransaction:      jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
      }))

      const { scValToNative } = jest.requireMock('@stellar/stellar-sdk') as typeof import('@stellar/stellar-sdk')
      ;(scValToNative as jest.Mock).mockReturnValueOnce(fakeSignersObj)

      const { result } = renderHook(() => useInvisibleWallet(CONFIG))

      let signers!: Awaited<ReturnType<typeof result.current.getSigners>>
      await act(async () => {
        signers = await result.current.getSigners()
      })

      expect(signers).toHaveLength(2)
      expect(signers[0].index).toBe(0)
      expect(signers[1].index).toBe(1)
    })

    it('throws when no wallet address is set', async () => {
      localStorage.removeItem('invisible_wallet_address')
      const { result } = renderHook(() => useInvisibleWallet(CONFIG))

      await act(async () => {
        await expect(result.current.getSigners()).rejects.toThrow('No wallet address')
      })
    })
  })
})
