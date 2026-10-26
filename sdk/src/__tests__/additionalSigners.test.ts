/**
 * @jest-environment node
 */
/**
 * Registering a second passkey (#1042).
 *
 * Three things are pinned here, because each one is a way to lose funds or to
 * ship a button that cannot work:
 *
 *  1. The credential sent to `__check_auth` is the five-element vector the
 *     contract requires, ending in the wallet nonce. The SDK used to send four.
 *  2. Adding a signer never writes the primary binding (address, credential
 *     id, public key, user handle, fee payer) — not on success, not on failure.
 *  3. The add-signer path is not `register()`, and a failure leaves no record
 *     that claims a key is a signer when it is not.
 *
 * The Stellar SDK is real here (XDR is built and parsed for real); only the RPC
 * server and the platform passkey prompt are stand-ins.
 */

import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  StrKey,
  nativeToScVal,
  scValToNative,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk'

import {
  ADDITIONAL_SIGNERS_KEY,
  AdditionalSignerStoreError,
  PrimaryBindingWriteError,
  guardPrimaryBinding,
  isPrimaryBindingKey,
  parseAdditionalSigners,
  readAdditionalSigners,
  saveAdditionalSigner,
  serializeAdditionalSigners,
  type AdditionalSigner,
} from '../additionalSigners'
import { WEBAUTHN_SIGNATURE_VECTOR_LENGTH, buildWebAuthnSignatureVector } from '../signatureVector'
import type { StorageAdapter } from '../core'

// ── RPC + WebAuthn stand-ins ──────────────────────────────────────────────────

const mockServer = {
  getAccount: jest.fn(),
  simulateTransaction: jest.fn(),
  getLatestLedger: jest.fn(),
  sendTransaction: jest.fn(),
  getTransaction: jest.fn(),
}

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk')
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: jest.fn(() => mockServer),
      // The enforce-mode simulation below is a stand-in, so it cannot carry a
      // real footprint; assembling is not what these tests are about.
      assembleTransaction: jest.fn((tx: unknown) => ({ build: () => tx })),
    },
  }
})

jest.mock('../webauthn', () => {
  const actual = jest.requireActual('../webauthn')
  return {
    ...actual,
    webAuthnProvider: { create: jest.fn(), authenticate: jest.fn() },
  }
})

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { InvisibleWalletCore } = require('../core') as typeof import('../core')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { webAuthnProvider } = require('../webauthn') as typeof import('../webauthn')
const mockCreate = webAuthnProvider.create as jest.Mock
const mockAuthenticate = webAuthnProvider.authenticate as jest.Mock

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WALLET = StrKey.encodeContract(Buffer.alloc(32, 7))
const FEE_PAYER = Keypair.random()
const WALLET_NONCE = 41n

function p256Key(fill: number): Uint8Array {
  const key = new Uint8Array(65).fill(fill)
  key[0] = 0x04
  return key
}
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

const PRIMARY_KEY = p256Key(1)
const NEW_KEY = p256Key(2)

const PRIMARY_BINDING: Record<string, string> = {
  invisible_wallet_address: WALLET,
  invisible_wallet_key_id: 'cHJpbWFyeS1jcmVk',
  invisible_wallet_public_key: hex(PRIMARY_KEY),
  invisible_wallet_user_id: 'aa'.repeat(16),
}

function memoryStore(initial: Record<string, string>): StorageAdapter & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v) },
    removeItem: (k) => { data.delete(k) },
  }
}

function primarySnapshot(store: { data: Map<string, string> }): Record<string, string | undefined> {
  return Object.fromEntries(Object.keys(PRIMARY_BINDING).map((k) => [k, store.data.get(k)]))
}

/** The auth entry recording-mode simulation returns: address credential, expiry 0. */
function recordingAuthEntry(fn: string, args: xdr.ScVal[]): xdr.SorobanAuthorizationEntry {
  const scAddr = new Address(WALLET).toScAddress()
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: scAddr,
        nonce: xdr.Int64.fromString('123456789'),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      })
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({ contractAddress: scAddr, functionName: fn, args })
      ),
      subInvocations: [],
    }),
  })
}

function invokedFunction(tx: Transaction): string {
  const op = tx.operations[0] as Operation.InvokeHostFunction
  return op.func.invokeContract().functionName().toString()
}

/** Wire the RPC stand-in. `signersAfter` is what get_signers returns. */
function wireServer(opts: { signersAfter?: Uint8Array[]; txStatus?: string } = {}) {
  const sent: Transaction[] = []
  mockServer.getAccount.mockImplementation(async () => new Account(FEE_PAYER.publicKey(), '100'))
  mockServer.getLatestLedger.mockResolvedValue({ sequence: 5000 })
  mockServer.simulateTransaction.mockImplementation(async (tx: Transaction) => {
    const fn = invokedFunction(tx)
    if (fn === 'get_nonce') {
      return { result: { retval: nativeToScVal(WALLET_NONCE, { type: 'u64' }) }, latestLedger: 1 }
    }
    if (fn === 'get_signers') {
      const map = new Map<number, Buffer>()
      ;[PRIMARY_KEY, ...(opts.signersAfter ?? [])].forEach((k, i) => map.set(i, Buffer.from(k)))
      return {
        result: {
          retval: xdr.ScVal.scvMap(
            Array.from(map, ([i, k]) => new xdr.ScMapEntry({
              key: nativeToScVal(i, { type: 'u32' }),
              val: nativeToScVal(k, { type: 'bytes' }),
            }))
          ),
        },
        latestLedger: 1,
      }
    }
    const op = tx.operations[0] as Operation.InvokeHostFunction
    if ((op.auth ?? []).length === 0) {
      // Recording mode: tell the caller which authorisation the contract wants.
      return {
        result: { retval: xdr.ScVal.scvVoid(), auth: [recordingAuthEntry(fn, op.func.invokeContract().args())] },
        latestLedger: 1,
      }
    }
    return { result: { retval: xdr.ScVal.scvVoid(), auth: [] }, latestLedger: 1 }
  })
  mockServer.sendTransaction.mockImplementation(async (tx: Transaction) => {
    sent.push(tx)
    return { status: 'PENDING', hash: 'a'.repeat(64) }
  })
  mockServer.getTransaction.mockResolvedValue({
    status: opts.txStatus ?? 'SUCCESS',
    returnValue: nativeToScVal(1, { type: 'u32' }),
  })
  return sent
}

function assertion() {
  return {
    authData: new Uint8Array(37).fill(5),
    clientDataJSON: new TextEncoder().encode('{"type":"webauthn.get"}'),
    signature: new Uint8Array(64).fill(6),
    publicKeyBytes: null,
  }
}

function makeWallet(store: StorageAdapter) {
  const core = new InvisibleWalletCore({
    factoryAddress: StrKey.encodeContract(Buffer.alloc(32, 9)),
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: Networks.TESTNET,
    rpId: 'app.useveilapp.xyz',
    storage: store,
  })
  core.hydrate()
  return core
}

beforeEach(() => {
  jest.clearAllMocks()
})

// ── 1. The signature vector ───────────────────────────────────────────────────

describe('buildWebAuthnSignatureVector', () => {
  const sig = { publicKey: PRIMARY_KEY, authData: new Uint8Array(37), clientDataJSON: new Uint8Array(10), signature: new Uint8Array(64) }

  it('has exactly the five elements __check_auth requires, nonce last as u64', () => {
    const vec = buildWebAuthnSignatureVector(sig, 41n).vec()!
    expect(WEBAUTHN_SIGNATURE_VECTOR_LENGTH).toBe(5)
    expect(vec).toHaveLength(5)
    expect(vec[4].switch().name).toBe('scvU64')
    expect(scValToNative(vec[4])).toBe(41n)
    expect(Buffer.from(scValToNative(vec[0]) as Buffer)).toEqual(Buffer.from(PRIMARY_KEY))
  })

  it('refuses a key or signature of the wrong shape rather than encode it', () => {
    expect(() => buildWebAuthnSignatureVector({ ...sig, publicKey: new Uint8Array(64) }, 0n)).toThrow(/65-byte/)
    expect(() => buildWebAuthnSignatureVector({ ...sig, signature: new Uint8Array(72) }, 0n)).toThrow(/64 bytes/)
  })
})

// ── 2. Storage separation ─────────────────────────────────────────────────────

describe('additional-signer storage', () => {
  const entry: AdditionalSigner = {
    credentialId: 'bmV3LWNyZWQ',
    publicKey: hex(NEW_KEY),
    status: 'pending',
    addedAt: '2026-10-24T00:00:00.000Z',
  }

  it('treats every primary-binding key, on either network, as off limits', () => {
    for (const key of Object.keys(PRIMARY_BINDING).concat('veil_signer_secret', 'invisible_wallet_portable_signer')) {
      expect(isPrimaryBindingKey(key)).toBe(true)
      expect(isPrimaryBindingKey(`${key}_mainnet`)).toBe(true)
    }
    expect(isPrimaryBindingKey(ADDITIONAL_SIGNERS_KEY)).toBe(false)
  })

  it('the guarded view throws on any primary write and leaves the value alone', () => {
    const store = memoryStore(PRIMARY_BINDING)
    const guarded = guardPrimaryBinding(store)
    expect(() => guarded.setItem('invisible_wallet_address', 'CSOMEWHERE_ELSE')).toThrow(PrimaryBindingWriteError)
    expect(() => guarded.setItem('invisible_wallet_key_id_mainnet', 'x')).toThrow(PrimaryBindingWriteError)
    expect(() => guarded.removeItem!('invisible_wallet_public_key')).toThrow(PrimaryBindingWriteError)
    expect(primarySnapshot(store)).toEqual(PRIMARY_BINDING)
  })

  it('saving an additional signer writes only its own key', async () => {
    const store = memoryStore(PRIMARY_BINDING)
    await saveAdditionalSigner(store, entry, { credentialId: PRIMARY_BINDING.invisible_wallet_key_id, publicKey: hex(PRIMARY_KEY) })
    expect(primarySnapshot(store)).toEqual(PRIMARY_BINDING)
    expect([...store.data.keys()].filter((k) => !(k in PRIMARY_BINDING))).toEqual([ADDITIONAL_SIGNERS_KEY])
    expect(await readAdditionalSigners(store)).toEqual([entry])
  })

  it('refuses to record the primary passkey as an "additional" one', async () => {
    const store = memoryStore(PRIMARY_BINDING)
    const primary = { credentialId: PRIMARY_BINDING.invisible_wallet_key_id, publicKey: hex(PRIMARY_KEY) }
    await expect(saveAdditionalSigner(store, { ...entry, credentialId: primary.credentialId }, primary)).rejects.toThrow(AdditionalSignerStoreError)
    await expect(saveAdditionalSigner(store, { ...entry, publicKey: hex(PRIMARY_KEY) }, primary)).rejects.toThrow(AdditionalSignerStoreError)
    expect(store.data.has(ADDITIONAL_SIGNERS_KEY)).toBe(false)
  })

  it('a corrupt record throws instead of reading as empty (which the next write would persist)', () => {
    expect(() => parseAdditionalSigners('{not json')).toThrow(AdditionalSignerStoreError)
    expect(() => parseAdditionalSigners(JSON.stringify({ version: 2, signers: [] }))).toThrow(AdditionalSignerStoreError)
    expect(() => parseAdditionalSigners(JSON.stringify({ version: 1, signers: [{ ...entry, publicKey: 'zz' }] }))).toThrow(AdditionalSignerStoreError)
    expect(parseAdditionalSigners(serializeAdditionalSigners([entry]))).toEqual([entry])
  })
})

// ── 3. addSigner / removeSigner are wallet-authorised ─────────────────────────

describe('addSigner()', () => {
  it('signs the wallet auth entry with a five-element credential carrying the live nonce and a real expiry', async () => {
    const store = memoryStore(PRIMARY_BINDING)
    const sent = wireServer()
    mockAuthenticate.mockResolvedValue(assertion())

    const res = await makeWallet(store).addSigner(FEE_PAYER, NEW_KEY)

    expect(res.signerIndex).toBe(1)
    expect(sent).toHaveLength(1)
    const op = sent[0].operations[0] as Operation.InvokeHostFunction
    expect(op.func.invokeContract().functionName().toString()).toBe('add_signer')
    const cred = op.auth![0].credentials().address()
    const vec = cred.signature().vec()!
    expect(vec).toHaveLength(5)
    expect(scValToNative(vec[4])).toBe(WALLET_NONCE)
    expect(Buffer.from(scValToNative(vec[0]) as Buffer)).toEqual(Buffer.from(PRIMARY_KEY))
    expect(cred.signatureExpirationLedger()).toBe(5100)
    // The primary passkey is the one asked to approve.
    expect(mockAuthenticate).toHaveBeenCalledWith(expect.objectContaining({ credentialId: PRIMARY_BINDING.invisible_wallet_key_id }))
  })

  it('refuses to submit when the contract did not ask for wallet authorisation', async () => {
    const store = memoryStore(PRIMARY_BINDING)
    wireServer()
    mockServer.simulateTransaction.mockResolvedValueOnce({ result: { retval: xdr.ScVal.scvVoid(), auth: [] }, latestLedger: 1 })

    await expect(makeWallet(store).addSigner(FEE_PAYER, NEW_KEY)).rejects.toThrow(/did not ask for authorisation/)
    expect(mockServer.sendTransaction).not.toHaveBeenCalled()
  })
})

describe('removeSigner()', () => {
  it('is wallet-authorised the same way', async () => {
    const store = memoryStore(PRIMARY_BINDING)
    const sent = wireServer()
    mockAuthenticate.mockResolvedValue(assertion())

    await makeWallet(store).removeSigner(FEE_PAYER, 1)

    const op = sent[0].operations[0] as Operation.InvokeHostFunction
    expect(op.func.invokeContract().functionName().toString()).toBe('remove_signer')
    expect(op.auth![0].credentials().address().signature().vec()).toHaveLength(5)
  })
})

// ── 4. registerAdditionalSigner ───────────────────────────────────────────────

describe('registerAdditionalSigner()', () => {
  function created() {
    return { credentialId: 'bmV3LWNyZWQ', publicKeyBytes: NEW_KEY, transports: ['hybrid'] }
  }

  it('adds the signer on chain and leaves the address, credential and fee payer exactly as they were', async () => {
    const store = memoryStore({ ...PRIMARY_BINDING, veil_signer_secret: FEE_PAYER.secret() })
    wireServer({ signersAfter: [NEW_KEY] })
    mockCreate.mockResolvedValue(created())
    mockAuthenticate.mockResolvedValue(assertion())
    const wallet = makeWallet(store)
    const registerSpy = jest.spyOn(wallet, 'register')

    const result = await wallet.registerAdditionalSigner(FEE_PAYER)

    expect(result).toEqual(expect.objectContaining({ walletAddress: WALLET, status: 'active', signerIndex: 1 }))
    expect(primarySnapshot(store)).toEqual(PRIMARY_BINDING)
    expect(store.data.get('veil_signer_secret')).toBe(FEE_PAYER.secret())
    expect(wallet.getState().address).toBe(WALLET)
    expect(registerSpy).not.toHaveBeenCalled()
    expect(await readAdditionalSigners(store)).toEqual([
      expect.objectContaining({ credentialId: 'bmV3LWNyZWQ', publicKey: hex(NEW_KEY), status: 'active', signerIndex: 1 }),
    ])
  })

  it('creates the credential under a fresh user handle and excludes the primary credential', async () => {
    const store = memoryStore(PRIMARY_BINDING)
    wireServer({ signersAfter: [NEW_KEY] })
    mockCreate.mockResolvedValue(created())
    mockAuthenticate.mockResolvedValue(assertion())

    await makeWallet(store).registerAdditionalSigner(FEE_PAYER)

    const request = mockCreate.mock.calls[0][0]
    expect(hex(request.userId)).not.toBe(PRIMARY_BINDING.invisible_wallet_user_id)
    expect(request.excludeCredentials).toEqual(expect.arrayContaining([expect.objectContaining({ id: PRIMARY_BINDING.invisible_wallet_key_id })]))
    expect(store.data.get('invisible_wallet_user_id')).toBe(PRIMARY_BINDING.invisible_wallet_user_id)
  })

  it('a cancelled creation writes nothing and submits nothing', async () => {
    const store = memoryStore(PRIMARY_BINDING)
    wireServer()
    mockCreate.mockRejectedValue(new Error('The operation was cancelled.'))

    await expect(makeWallet(store).registerAdditionalSigner(FEE_PAYER)).rejects.toThrow(/cancelled/)
    expect(Object.fromEntries(store.data)).toEqual(PRIMARY_BINDING)
    expect(mockServer.sendTransaction).not.toHaveBeenCalled()
  })

  it('declining the approval with the existing passkey forgets the new credential and keeps the binding', async () => {
    const store = memoryStore(PRIMARY_BINDING)
    wireServer()
    mockCreate.mockResolvedValue(created())
    mockAuthenticate.mockRejectedValue(new Error('NotAllowedError: user cancelled'))

    await expect(makeWallet(store).registerAdditionalSigner(FEE_PAYER)).rejects.toThrow(/cancelled/)
    expect(primarySnapshot(store)).toEqual(PRIMARY_BINDING)
    expect(await readAdditionalSigners(store)).toEqual([])
    expect(mockServer.sendTransaction).not.toHaveBeenCalled()
  })

  it('an SDK/RPC error before submission is the same: nothing recorded, binding intact', async () => {
    const store = memoryStore(PRIMARY_BINDING)
    wireServer()
    mockCreate.mockResolvedValue(created())
    mockAuthenticate.mockResolvedValue(assertion())
    mockServer.simulateTransaction.mockResolvedValueOnce({ error: 'HostError: Error(Contract, #3)', latestLedger: 1 })

    await expect(makeWallet(store).registerAdditionalSigner(FEE_PAYER)).rejects.toThrow(/Simulation failed/)
    expect(primarySnapshot(store)).toEqual(PRIMARY_BINDING)
    expect(await readAdditionalSigners(store)).toEqual([])
  })

  it('a failure AFTER the network accepted the transaction keeps the credential as pending, binding intact', async () => {
    const store = memoryStore(PRIMARY_BINDING)
    wireServer({ txStatus: 'FAILED' })
    mockCreate.mockResolvedValue(created())
    mockAuthenticate.mockResolvedValue(assertion())

    await expect(makeWallet(store).registerAdditionalSigner(FEE_PAYER)).rejects.toThrow(/FAILED/)
    expect(primarySnapshot(store)).toEqual(PRIMARY_BINDING)
    expect(await readAdditionalSigners(store)).toEqual([expect.objectContaining({ status: 'pending' })])
  })

  it('refuses outright on a device with no primary passkey', async () => {
    const store = memoryStore({ invisible_wallet_address: WALLET })
    await expect(makeWallet(store).registerAdditionalSigner(FEE_PAYER)).rejects.toThrow(/no primary passkey/)
    expect(mockCreate).not.toHaveBeenCalled()
  })
})
