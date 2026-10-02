/**
 * Tests for roaming FIDO2 security-key support (cross-platform authenticators).
 *
 * Covers both the WebAuthn provider (registration/assertion option plumbing) and
 * the useInvisibleWallet hook (persisting a roaming credential as a portable
 * signer, independent of platform passkeys, and replaying its transports when
 * signing from another device).
 */

import { renderHook, act } from '@testing-library/react'
import { useInvisibleWallet } from '../useInvisibleWallet'
import { webAuthnProvider } from '../webauthn'

// ── @stellar/stellar-sdk mock ─────────────────────────────────────────────────
// Mirrors useInvisibleWallet.test.ts — no real network calls are made.

jest.mock('@stellar/stellar-sdk', () => ({
  Networks: {
    TESTNET: 'Test SDF Network ; September 2015',
    PUBLIC:  'Public Global Stellar Network ; September 2015',
  },
  BASE_FEE: '100',
  rpc: {
    Server: jest.fn().mockImplementation(() => ({
      getContractData:     jest.fn().mockResolvedValue({}),
      simulateTransaction: jest.fn().mockResolvedValue({ result: { retval: {} } }),
      sendTransaction:     jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'mock-hash' }),
      getTransaction:      jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
    })),
    Api: {
      GetTransactionStatus: { SUCCESS: 'SUCCESS', NOT_FOUND: 'NOT_FOUND', FAILED: 'FAILED' },
      isSimulationError: jest.fn(() => false),
    },
    Durability: { Persistent: 'persistent' },
    assembleTransaction: jest.fn().mockReturnValue({
      build: jest.fn().mockReturnValue({ sign: jest.fn(), toXDR: jest.fn() }),
    }),
  },
  Horizon: { Server: jest.fn() },
  Account: jest.fn(),
  Contract: jest.fn().mockImplementation(() => ({ call: jest.fn() })),
  Keypair: { random: jest.fn(), fromSecret: jest.fn() },
  TransactionBuilder: jest.fn(),
  xdr: { ScVal: { scvLedgerKeyContractInstance: jest.fn() } },
  nativeToScVal: jest.fn(),
  scValToNative: jest.fn(),
  Asset: { native: jest.fn() },
}))

// ── ./utils mock ──────────────────────────────────────────────────────────────

jest.mock('../utils', () => ({
  bufferToHex:          jest.fn(() => 'deadbeef'),
  hexToUint8Array:      jest.fn(() => new Uint8Array(65).fill(4)),
  derToRawSignature:    jest.fn(() => new Uint8Array(64).fill(1)),
  extractP256PublicKey: jest.fn().mockResolvedValue(new Uint8Array(65).fill(4)),
  computeWalletAddress: jest.fn(() => 'CWALLET_ADDRESS_MOCK'),
}))

// ── WebAuthn + crypto mocks ───────────────────────────────────────────────────

const mockCredentialsCreate = jest.fn()
const mockCredentialsGet    = jest.fn()

Object.defineProperty(global, 'navigator', {
  value: { credentials: { create: mockCredentialsCreate, get: mockCredentialsGet } },
  writable: true,
  configurable: true,
})

Object.defineProperty(global, 'crypto', {
  value: { getRandomValues: jest.fn((arr: Uint8Array) => (arr.fill(42), arr)) },
  writable: true,
  configurable: true,
})

const CONFIG = {
  factoryAddress:    'CFACTORY_ADDRESS',
  rpcUrl:            'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
}

/** A roaming security-key registration credential (cross-platform attachment). */
function makeRoamingRegistrationCredential() {
  return {
    id:   'cm9hbWluZy1rZXktaWQ',
    type: 'public-key',
    authenticatorAttachment: 'cross-platform',
    response: {
      attestationObject: new ArrayBuffer(32),
      clientDataJSON:    new ArrayBuffer(32),
      getTransports:     jest.fn(() => ['usb', 'nfc']),
    },
  }
}

/** A platform passkey registration credential (device-bound). */
function makePlatformRegistrationCredential() {
  return {
    id:   'cGxhdGZvcm0ta2V5LWlk',
    type: 'public-key',
    authenticatorAttachment: 'platform',
    response: {
      attestationObject: new ArrayBuffer(32),
      clientDataJSON:    new ArrayBuffer(32),
      getTransports:     jest.fn(() => ['internal']),
    },
  }
}

function makeAssertionCredential() {
  return {
    id:   'cm9hbWluZy1rZXktaWQ',
    type: 'public-key',
    response: {
      authenticatorData: new ArrayBuffer(37),
      clientDataJSON:    new ArrayBuffer(64),
      signature:         new ArrayBuffer(72),
      userHandle:        null,
    },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  localStorage.clear()
})

// ── WebAuthn provider: cross-platform attachment options ──────────────────────

describe('webAuthnProvider — cross-platform attachment options', () => {
  it('requests a cross-platform authenticator and a resident credential when roaming', async () => {
    mockCredentialsCreate.mockResolvedValueOnce(makeRoamingRegistrationCredential())

    await webAuthnProvider.create({
      challenge: new Uint8Array(32),
      rpId:      'localhost',
      rpName:    'Invisible Wallet',
      userId:    new Uint8Array(16),
      userName:  'alice',
      authenticatorAttachment: 'cross-platform',
    })

    const opts = mockCredentialsCreate.mock.calls[0][0].publicKey
    expect(opts.authenticatorSelection.authenticatorAttachment).toBe('cross-platform')
    expect(opts.authenticatorSelection.residentKey).toBe('required')
  })

  it('does not pin an attachment and prefers a resident key for a default (platform) credential', async () => {
    mockCredentialsCreate.mockResolvedValueOnce(makePlatformRegistrationCredential())

    await webAuthnProvider.create({
      challenge: new Uint8Array(32),
      rpId:      'localhost',
      rpName:    'Invisible Wallet',
      userId:    new Uint8Array(16),
      userName:  'alice',
    })

    const opts = mockCredentialsCreate.mock.calls[0][0].publicKey
    expect(opts.authenticatorSelection.authenticatorAttachment).toBeUndefined()
    expect(opts.authenticatorSelection.residentKey).toBe('preferred')
  })

  it('reports the attachment and transports from the registration response', async () => {
    mockCredentialsCreate.mockResolvedValueOnce(makeRoamingRegistrationCredential())

    const result = await webAuthnProvider.create({
      challenge: new Uint8Array(32),
      rpId:      'localhost',
      rpName:    'Invisible Wallet',
      userId:    new Uint8Array(16),
      userName:  'alice',
      authenticatorAttachment: 'cross-platform',
    })

    expect(result.authenticatorAttachment).toBe('cross-platform')
    expect(result.transports).toEqual(['usb', 'nfc'])
  })

  it('forwards stored transports to allowCredentials on assertion', async () => {
    mockCredentialsGet.mockResolvedValueOnce(makeAssertionCredential())

    await webAuthnProvider.authenticate({
      challenge:    new ArrayBuffer(32),
      credentialId: 'cm9hbWluZy1rZXktaWQ',
      transports:   ['usb', 'nfc'],
    })

    const opts = mockCredentialsGet.mock.calls[0][0].publicKey
    expect(opts.allowCredentials[0].transports).toEqual(['usb', 'nfc'])
  })
})

// ── Hook: portable signer persistence + signing ───────────────────────────────

describe('useInvisibleWallet — roaming key as a portable signer', () => {
  it('persists a roaming credential as a portable signer independent of platform passkeys', async () => {
    mockCredentialsCreate.mockResolvedValueOnce(makeRoamingRegistrationCredential())

    const { result } = renderHook(() => useInvisibleWallet(CONFIG))

    let registerResult!: Awaited<ReturnType<typeof result.current.register>>
    await act(async () => {
      registerResult = await result.current.register('alice', { authenticatorAttachment: 'cross-platform' })
    })

    expect(registerResult!.isPortableSigner).toBe(true)
    expect(registerResult!.authenticatorAttachment).toBe('cross-platform')

    // Stored under a dedicated key, separate from the platform-passkey keys.
    const stored = localStorage.getItem('invisible_wallet_portable_signer')
    expect(stored).not.toBeNull()
    const parsed = JSON.parse(stored!)
    expect(parsed.authenticatorAttachment).toBe('cross-platform')
    expect(parsed.transports).toEqual(['usb', 'nfc'])
    expect(parsed.credentialId).toBe('cm9hbWluZy1rZXktaWQ')
  })

  it('does not persist a portable signer for a platform passkey', async () => {
    mockCredentialsCreate.mockResolvedValueOnce(makePlatformRegistrationCredential())

    const { result } = renderHook(() => useInvisibleWallet(CONFIG))

    let registerResult!: Awaited<ReturnType<typeof result.current.register>>
    await act(async () => { registerResult = await result.current.register('bob') })

    expect(registerResult!.isPortableSigner).toBe(false)
    expect(localStorage.getItem('invisible_wallet_portable_signer')).toBeNull()
  })

  it('exposes the portable signer via getPortableSigner()', async () => {
    mockCredentialsCreate.mockResolvedValueOnce(makeRoamingRegistrationCredential())

    const { result } = renderHook(() => useInvisibleWallet(CONFIG))
    await act(async () => { await result.current.register('alice', { authenticatorAttachment: 'cross-platform' }) })

    let signer!: Awaited<ReturnType<typeof result.current.getPortableSigner>>
    await act(async () => { signer = await result.current.getPortableSigner() })

    expect(signer).not.toBeNull()
    expect(signer!.authenticatorAttachment).toBe('cross-platform')
    expect(signer!.transports).toEqual(['usb', 'nfc'])
  })

  it('returns null from getPortableSigner() when only a platform passkey is registered', async () => {
    mockCredentialsCreate.mockResolvedValueOnce(makePlatformRegistrationCredential())

    const { result } = renderHook(() => useInvisibleWallet(CONFIG))
    await act(async () => { await result.current.register('bob') })

    let signer!: Awaited<ReturnType<typeof result.current.getPortableSigner>>
    await act(async () => { signer = await result.current.getPortableSigner() })

    expect(signer).toBeNull()
  })

  it('replays the roaming key transports when signing (e.g. from a second device)', async () => {
    // Simulate a device that already holds the roaming credential in storage —
    // the case of signing from a machine other than where the key was enrolled.
    localStorage.setItem('invisible_wallet_key_id', 'cm9hbWluZy1rZXktaWQ')
    localStorage.setItem('invisible_wallet_public_key', 'deadbeef')
    localStorage.setItem('invisible_wallet_portable_signer', JSON.stringify({
      credentialId: 'cm9hbWluZy1rZXktaWQ',
      publicKey: 'deadbeef',
      authenticatorAttachment: 'cross-platform',
      transports: ['usb', 'nfc'],
    }))

    mockCredentialsGet.mockResolvedValueOnce(makeAssertionCredential())

    const { result } = renderHook(() => useInvisibleWallet(CONFIG))
    const payload = new Uint8Array(32).fill(9)

    let sig!: Awaited<ReturnType<typeof result.current.signAuthEntry>>
    await act(async () => { sig = await result.current.signAuthEntry(payload) })

    expect(sig).not.toBeNull()
    const opts = mockCredentialsGet.mock.calls[0][0].publicKey
    expect(opts.allowCredentials[0].transports).toEqual(['usb', 'nfc'])
  })
})
