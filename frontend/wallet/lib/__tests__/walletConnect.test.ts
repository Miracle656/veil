/**
 * @jest-environment jsdom
 *
 * Tests for lib/walletConnect.ts: the surface through which other applications
 * ask this wallet to sign. It is the part of the wallet most exposed to input
 * we do not control, so the rejections come first.
 *
 * What is real here: the module itself, @stellar/stellar-sdk (XDR parsing,
 * auth-entry hashing, envelope signing) and @walletconnect/utils (the error
 * codes a dApp receives). What is faked: the WalletKit client (no relay), the
 * Soroban RPC (no network) and `navigator.credentials` (no authenticator). The
 * fakes record what they were asked, which is how "nothing was signed" is
 * proven: `Transaction.prototype.sign` is spied on, and so is the passkey.
 *
 * jsdom doesn't provide WebCrypto / TextEncoder / TextDecoder, but the module
 * hashes with crypto.subtle and stellar-sdk needs them at import time.
 */

import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
  writable: true,
})
Object.assign(globalThis, { TextEncoder, TextDecoder })

jest.mock('@reown/walletkit', () => ({ WalletKit: { init: jest.fn() } }), { virtual: true })
jest.mock('@walletconnect/core', () => ({ Core: jest.fn() }), { virtual: true })
// The real package pulls in an ESM-only dependency jest cannot load. These are
// the entries of its published error tables (getSdkError / getInternalError)
// the module uses, copied verbatim: the codes are WalletConnect protocol, so a
// dApp reads them, and a change to them here should be a deliberate one.
jest.mock(
  '@walletconnect/utils',
  () => {
    const SDK: Record<string, { message: string; code: number }> = {
      USER_REJECTED: { message: 'User rejected.', code: 5000 },
      UNSUPPORTED_CHAINS: { message: 'Unsupported chains.', code: 5100 },
      UNSUPPORTED_ACCOUNTS: { message: 'Unsupported accounts.', code: 5103 },
      USER_DISCONNECTED: { message: 'User disconnected.', code: 6000 },
    }
    const INTERNAL: Record<string, { message: string; code: number }> = {
      EXPIRED: { message: 'Expired.', code: 6 },
    }
    const lookup = (table: typeof SDK, key: string) => {
      if (!table[key]) throw new Error(`walletConnect.test: add ${key} to the @walletconnect/utils stub`)
      return { ...table[key] }
    }
    return {
      getSdkError: (key: string) => lookup(SDK, key),
      getInternalError: (key: string) => lookup(INTERNAL, key),
    }
  },
  { virtual: true },
)

type Sdk = typeof import('@stellar/stellar-sdk')
type Wc = typeof import('../walletConnect')

const TESTNET = 'stellar:testnet'
const PUBNET = 'stellar:pubnet'
const SESSION_STORAGE_KEY = 'veil_walletconnect_sessions'

// ── Fixture identities ────────────────────────────────────────────────────────
// Derived from fixed bytes at runtime rather than written as literals, so every
// address below is a full, valid strkey and none can be mistyped or shortened.

let sdk: Sdk
let wc: Wc
let WALLET: string // the connected wallet contract
let OTHER_WALLET: string // a contract that is not the connected wallet
let TOKEN: string // the contract the dApp calls
let feePayer: import('@stellar/stellar-sdk').Keypair
let dappSource: import('@stellar/stellar-sdk').Keypair

// ── Fakes ─────────────────────────────────────────────────────────────────────

type FakeClient = ReturnType<typeof makeClient>

function makeClient() {
  const handlers: Record<string, (event: any) => void> = {}
  const active: Record<string, any> = {}
  return {
    handlers,
    active,
    on: jest.fn((name: string, handler: (event: any) => void) => {
      handlers[name] = handler
    }),
    getActiveSessions: jest.fn(() => active),
    respondSessionRequest: jest.fn(async (_args: any) => {}),
    approveSession: jest.fn(async (_args: any) => {}),
    rejectSession: jest.fn(async (_args: any) => {}),
    disconnectSession: jest.fn(async (_args: any) => {}),
    pair: jest.fn(async (_args: any) => {}),
  }
}

/** A session as WalletKit stores it. `expiry` is unix seconds. */
function rawSession(topic: string, opts: { chain?: string; address?: string; expiry?: number } = {}) {
  const chain = opts.chain ?? TESTNET
  return {
    topic,
    expiry: opts.expiry ?? Math.floor(Date.now() / 1000) + 3600,
    namespaces: {
      stellar: {
        accounts: [`${chain}:${opts.address ?? WALLET}`],
        methods: ['stellar_signXDR', 'stellar_signAndSubmitXDR'],
        events: [],
      },
    },
    peer: { metadata: { name: 'Test dApp', url: 'https://dapp.test' } },
  }
}

let client: FakeClient
let rpc: {
  simulateTransaction: jest.SpyInstance
  getLatestLedger: jest.SpyInstance
  getAccount: jest.SpyInstance
  sendTransaction: jest.SpyInstance
  getContractData: jest.SpyInstance
}
let passkey: jest.Mock
let txSign: jest.SpyInstance
/** The auth entries the recording-mode simulation hands back. */
let simAuth: () => any[]

/** A successful simulation in the parsed shape `rpc.Server` returns. */
function simSuccess(auth: any[], retval = sdk.xdr.ScVal.scvVoid()) {
  return {
    _parsed: true,
    id: '1',
    latestLedger: 1000,
    events: [],
    transactionData: new sdk.SorobanDataBuilder(),
    minResourceFee: '1000',
    result: { auth, retval },
  }
}

function addressEntry(address: string) {
  const { xdr, Address } = sdk
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(address).toScAddress(),
        nonce: xdr.Int64.fromString('7'),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: invocation(),
  })
}

function sourceAccountEntry() {
  const { xdr } = sdk
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: invocation(),
  })
}

function invocation() {
  const { xdr, Address } = sdk
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(TOKEN).toScAddress(),
        functionName: 'transfer',
        args: [],
      }),
    ),
    subInvocations: [],
  })
}

/** A transaction a dApp would send: one contract call, built on testnet. */
function dappTxXdr(build?: (b: import('@stellar/stellar-sdk').TransactionBuilder) => void): string {
  const builder = new sdk.TransactionBuilder(new sdk.Account(dappSource.publicKey(), '1'), {
    fee: '100',
    networkPassphrase: sdk.Networks.TESTNET,
  })
  if (build) build(builder)
  else builder.addOperation(new sdk.Contract(TOKEN).call('transfer'))
  return builder.setTimeout(30).build().toXDR()
}

function request(method: string, params: unknown, opts: { topic?: string; chainId?: unknown; id?: number } = {}) {
  return {
    id: opts.id ?? 42,
    topic: opts.topic ?? 'topic-1',
    params: {
      chainId: 'chainId' in opts ? opts.chainId : TESTNET,
      request: { method, params },
    },
  }
}

/** A DER-encoded P-256 signature, the shape an authenticator returns. */
function derSignature(): ArrayBuffer {
  const r = new Uint8Array(32).fill(0x11)
  const s = new Uint8Array(32).fill(0x22)
  return new Uint8Array([0x30, 0x44, 0x02, 0x20, ...r, 0x02, 0x20, ...s]).buffer
}

const PASSKEY_PUBLIC_KEY_HEX = '04' + 'ab'.repeat(64)

function lastResponse() {
  const calls = client.respondSessionRequest.mock.calls
  return calls[calls.length - 1]?.[0]?.response
}

/** Nothing left this module carrying a signature, and the network saw nothing. */
function expectNothingSigned() {
  expect(txSign).not.toHaveBeenCalled()
  expect(rpc.sendTransaction).not.toHaveBeenCalled()
  for (const [args] of client.respondSessionRequest.mock.calls) {
    expect(args.response.result).toBeUndefined()
  }
}

/**
 * Fresh module state per test: the module keeps its client and session list in
 * module scope, so each test re-imports it (and the SDK it uses, so the
 * fixtures and the module share one copy of the XDR types).
 */
async function load(opts: { init?: boolean } = {}) {
  jest.resetModules()
  sdk = require('@stellar/stellar-sdk')
  wc = require('../walletConnect')

  WALLET = sdk.StrKey.encodeContract(Buffer.alloc(32, 1))
  OTHER_WALLET = sdk.StrKey.encodeContract(Buffer.alloc(32, 2))
  TOKEN = sdk.StrKey.encodeContract(Buffer.alloc(32, 3))
  feePayer = sdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4))
  dappSource = sdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 5))

  localStorage.setItem('veil_signer_secret', feePayer.secret())
  localStorage.setItem('invisible_wallet_key_id', 'AQIDBAUGBwg')
  localStorage.setItem('invisible_wallet_public_key', PASSKEY_PUBLIC_KEY_HEX)
  localStorage.setItem('invisible_wallet_address', WALLET)

  simAuth = () => [addressEntry(WALLET)]

  const proto = sdk.rpc.Server.prototype as any
  rpc = {
    simulateTransaction: jest.spyOn(proto, 'simulateTransaction').mockImplementation(async (tx: any) => {
      const op = tx.operations[0]
      const fn = op.func.invokeContract().functionName().toString()
      if (fn === 'get_nonce') return simSuccess([], sdk.nativeToScVal(9n, { type: 'u64' }))
      // The enforce-mode re-simulation carries the signed entries.
      if (op.auth && op.auth.length > 0) return simSuccess([])
      return simSuccess(simAuth())
    }),
    getLatestLedger: jest.spyOn(proto, 'getLatestLedger').mockResolvedValue({ sequence: 1000 }),
    getAccount: jest
      .spyOn(proto, 'getAccount')
      .mockImplementation(async () => new sdk.Account(feePayer.publicKey(), '5')),
    sendTransaction: jest
      .spyOn(proto, 'sendTransaction')
      .mockResolvedValue({ status: 'PENDING', hash: 'c'.repeat(64) }),
    // getDeploymentState reads the contract instance; resolving means deployed.
    getContractData: jest.spyOn(proto, 'getContractData').mockResolvedValue({}),
  }
  txSign = jest.spyOn(sdk.Transaction.prototype, 'sign')

  passkey = jest.fn(async () => ({
    response: {
      authenticatorData: new Uint8Array(37).fill(7).buffer,
      clientDataJSON: new TextEncoder().encode('{"type":"webauthn.get"}').buffer,
      signature: derSignature(),
    },
  }))
  Object.defineProperty(navigator, 'credentials', {
    value: { get: passkey },
    configurable: true,
  })

  client = makeClient()
  client.active['topic-1'] = rawSession('topic-1')
  const { WalletKit } = require('@reown/walletkit')
  WalletKit.init.mockResolvedValue(client)

  process.env.NEXT_PUBLIC_WC_PROJECT_ID = 'test-project'
  if (opts.init !== false) await wc.getWalletConnectClient()
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  jest.restoreAllMocks()
  delete process.env.NEXT_PUBLIC_WC_PROJECT_ID
})

// ── Refusals ──────────────────────────────────────────────────────────────────

describe('requests that are refused before anything is signed', () => {
  beforeEach(() => load())

  it('refuses an unsupported method', async () => {
    // A dApp could otherwise invent a method name and get a silent no-op it reads as success.
    await wc.handleSignXdrRequest(request('stellar_signSomethingElse', dappTxXdr()))
    expect(lastResponse()).toEqual({
      id: 42,
      jsonrpc: '2.0',
      error: { code: 10001, message: 'Unsupported method: stellar_signSomethingElse' },
    })
    expect(passkey).not.toHaveBeenCalled()
    expectNothingSigned()
  })

  it('refuses a request for a chain the wallet is not on', async () => {
    // The XDR carries no network: without this check, a transaction asked for on
    // mainnet would be signed for testnet (or the reverse) and replayable there.
    await wc.handleSignXdrRequest(request('stellar_signXDR', dappTxXdr(), { chainId: PUBNET }))
    expect(lastResponse().error.code).toBe(5100) // UNSUPPORTED_CHAINS
    expect(lastResponse().error.message).toBe(`This wallet is on ${TESTNET}; the request was for ${PUBNET}.`)
    expect(rpc.simulateTransaction).not.toHaveBeenCalled()
    expect(passkey).not.toHaveBeenCalled()
    expectNothingSigned()
  })

  it('refuses a request that names no chain', async () => {
    // Missing must not mean "whatever is active".
    await wc.handleSignXdrRequest(request('stellar_signXDR', dappTxXdr(), { chainId: undefined }))
    expect(lastResponse().error.code).toBe(5100)
    expectNothingSigned()
  })

  it('refuses a request on a session that was approved for the other network', async () => {
    // The session's grant is what the user consented to; a matching chainId on the
    // request does not override a session approved for pubnet.
    client.active['topic-1'] = rawSession('topic-1', { chain: PUBNET })
    await wc.handleSignXdrRequest(request('stellar_signXDR', dappTxXdr()))
    expect(lastResponse().error.code).toBe(5100)
    expect(lastResponse().error.message).toBe(`This dApp was connected on ${PUBNET}, not ${TESTNET}.`)
    expectNothingSigned()
  })

  it.each([
    ['no params at all', undefined],
    ['an empty object', {}],
    ['a number', 7],
    ['an array with no XDR', [{ foo: 'bar' }]],
  ])('refuses a request with %s as its payload', async (_label, params) => {
    await wc.handleSignXdrRequest(request('stellar_signXDR', params))
    expect(lastResponse().error).toEqual({
      code: -32602,
      message: 'Missing XDR payload in WalletConnect request.',
    })
    expect(rpc.simulateTransaction).not.toHaveBeenCalled()
    expectNothingSigned()
  })

  it('refuses XDR that is not a transaction', async () => {
    await wc.handleSignXdrRequest(request('stellar_signXDR', 'bm90IGEgdHJhbnNhY3Rpb24='))
    expect(lastResponse().error).toEqual({
      code: -32602,
      message: 'The request does not contain a readable Stellar transaction.',
    })
    expect(rpc.simulateTransaction).not.toHaveBeenCalled()
    expectNothingSigned()
  })

  it('refuses a transaction with more than one operation', async () => {
    // Only the first operation is rebuilt and submitted; the rest would vanish
    // from what was signed without anyone being told.
    const xdrString = dappTxXdr((b) =>
      b
        .addOperation(new sdk.Contract(TOKEN).call('transfer'))
        .addOperation(new sdk.Contract(TOKEN).call('transfer')),
    )
    await wc.handleSignXdrRequest(request('stellar_signXDR', xdrString))
    expect(lastResponse().error).toEqual({
      code: -32602,
      message: 'The request must be a single contract call (one invokeHostFunction operation).',
    })
    expectNothingSigned()
  })

  it('refuses a classic payment', async () => {
    // A classic op's authority is the envelope signature, which here is the fee payer's.
    const xdrString = dappTxXdr((b) =>
      b.addOperation(
        sdk.Operation.payment({
          destination: dappSource.publicKey(),
          asset: sdk.Asset.native(),
          amount: '1',
          source: feePayer.publicKey(),
        }),
      ),
    )
    await wc.handleSignXdrRequest(request('stellar_signAndSubmitXDR', xdrString))
    expect(lastResponse().error.code).toBe(-32602)
    expect(rpc.simulateTransaction).not.toHaveBeenCalled()
    expectNothingSigned()
  })

  it('refuses a fee-bump transaction', async () => {
    const inner = sdk.TransactionBuilder.fromXDR(dappTxXdr(), sdk.Networks.TESTNET) as any
    inner.sign(dappSource)
    const bump = sdk.TransactionBuilder.buildFeeBumpTransaction(dappSource, '200', inner, sdk.Networks.TESTNET)
    txSign.mockClear()
    await wc.handleSignXdrRequest(request('stellar_signXDR', bump.toXDR()))
    expect(lastResponse().error).toEqual({ code: -32602, message: 'Fee-bump transactions are not accepted.' })
    expectNothingSigned()
  })

  it('refuses a call that asks the source account to authorize', async () => {
    // The rebuilt envelope's source is the fee payer, so a source-account entry
    // would authorize as the fee payer with no passkey involved: a drain path.
    simAuth = () => [addressEntry(WALLET), sourceAccountEntry()]
    await wc.handleSignXdrRequest(request('stellar_signAndSubmitXDR', dappTxXdr()))
    expect(lastResponse().error.code).toBe(5103) // UNSUPPORTED_ACCOUNTS
    expect(passkey).not.toHaveBeenCalled()
    expectNothingSigned()
  })

  it('refuses a call that asks for authorization from a different contract', async () => {
    // The same passkey can control more than one wallet contract. A dApp connected
    // to this one must not get a signature for another.
    simAuth = () => [addressEntry(OTHER_WALLET)]
    await wc.handleSignXdrRequest(request('stellar_signXDR', dappTxXdr()))
    expect(lastResponse().error).toEqual({
      code: 5103,
      message: `The request asks for authorization from ${OTHER_WALLET}, which is not the connected wallet ${WALLET}.`,
    })
    expect(passkey).not.toHaveBeenCalled()
    expectNothingSigned()
  })

  it('refuses a call that needs no authorization from this wallet', async () => {
    // Otherwise the fee payer signs, and pays for, a transaction the passkey never saw.
    simAuth = () => []
    for (const method of ['stellar_signXDR', 'stellar_signAndSubmitXDR']) {
      await wc.handleSignXdrRequest(request(method, dappTxXdr()))
      expect(lastResponse().error).toEqual({
        code: -32602,
        message: 'The request needs no authorization from this wallet, so there is nothing for it to sign.',
      })
    }
    expect(passkey).not.toHaveBeenCalled()
    expectNothingSigned()
  })

  it('refuses when the simulation fails, naming the failure', async () => {
    rpc.simulateTransaction.mockResolvedValueOnce({ id: '1', latestLedger: 1000, events: [], error: 'HostError: boom' })
    await wc.handleSignXdrRequest(request('stellar_signXDR', dappTxXdr()))
    expect(lastResponse().error).toEqual({ code: 5000, message: 'Simulation failed: HostError: boom' })
    expect(passkey).not.toHaveBeenCalled()
    expectNothingSigned()
  })

  it('stops with the activation message when the wallet contract is not deployed', async () => {
    // __check_auth runs on chain; a passkey signature for a contract that does not
    // exist is guaranteed to be rejected, so the user is not asked for one.
    rpc.getContractData.mockRejectedValue(new Error('HostError: Error(Storage, MissingValue)'))
    await wc.handleSignXdrRequest(request('stellar_signXDR', dappTxXdr()))
    expect(lastResponse().error.code).toBe(5000)
    expect(lastResponse().error.message).toContain(feePayer.publicKey())
    expect(passkey).not.toHaveBeenCalled()
    expectNothingSigned()
  })
})

// ── Sessions that are gone ────────────────────────────────────────────────────

describe('requests on a session that has ended', () => {
  beforeEach(() => load())

  it('refuses a request on an expired session and drops it from the list', async () => {
    // WalletKit does not announce expiry, so the check has to happen here.
    client.active['topic-1'] = rawSession('topic-1', { expiry: Math.floor(Date.now() / 1000) - 1 })
    const seen: string[][] = []
    wc.subscribeWalletConnectSessions((s) => seen.push(s.map((x) => x.topic)))

    await expect(wc.handleSignXdrRequest(request('stellar_signXDR', dappTxXdr()))).rejects.toMatchObject({
      name: 'WalletConnectRefusal',
      code: 6, // EXPIRED
      message: 'This dApp connection has ended. Reconnect the dApp and try again.',
    })
    // There is no live session to answer on, so nothing is sent.
    expect(client.respondSessionRequest).not.toHaveBeenCalled()
    expect(wc.getWalletConnectSessions()).toEqual([])
    expect(seen[seen.length - 1]).toEqual([])
    expect(passkey).not.toHaveBeenCalled()
    expectNothingSigned()
  })

  it('refuses a request on a topic the client does not know', async () => {
    await expect(
      wc.handleSignXdrRequest(request('stellar_signAndSubmitXDR', dappTxXdr(), { topic: 'unknown-topic' })),
    ).rejects.toBeInstanceOf(wc.WalletConnectRefusal)
    expect(client.respondSessionRequest).not.toHaveBeenCalled()
    expectNothingSigned()
  })

  it('throws when the client was never initialised', async () => {
    await load({ init: false })
    await expect(wc.handleSignXdrRequest(request('stellar_signXDR', dappTxXdr()))).rejects.toThrow(
      'WalletConnect client not initialized.',
    )
    expectNothingSigned()
  })
})

// ── The approval step ─────────────────────────────────────────────────────────

describe('no signing path completes without the passkey', () => {
  beforeEach(() => load())

  it('only announces an incoming request; it signs nothing and answers nothing', async () => {
    // session_request is the dApp talking. The user's approval happens in
    // WalletConnectApprovalModal, which listens for this event.
    const heard: any[] = []
    const listener = (e: Event) => heard.push((e as CustomEvent).detail)
    window.addEventListener('wc:request', listener)
    const event = request('stellar_signAndSubmitXDR', dappTxXdr())
    client.handlers.session_request(event)
    window.removeEventListener('wc:request', listener)

    expect(heard).toEqual([event])
    await Promise.resolve()
    expect(passkey).not.toHaveBeenCalled()
    expect(rpc.simulateTransaction).not.toHaveBeenCalled()
    expect(client.respondSessionRequest).not.toHaveBeenCalled()
    expectNothingSigned()
  })

  it.each(['stellar_signXDR', 'stellar_signAndSubmitXDR'])(
    '%s: a cancelled passkey prompt is answered as a user rejection',
    async (method) => {
      passkey.mockResolvedValue(null)
      await wc.handleSignXdrRequest(request(method, dappTxXdr()))
      expect(passkey).toHaveBeenCalledTimes(1)
      expect(lastResponse().error).toEqual({ code: 5000, message: 'User rejected.' })
      expectNothingSigned()
    },
  )

  it.each(['stellar_signXDR', 'stellar_signAndSubmitXDR'])(
    '%s: a refused passkey (NotAllowedError) is answered as a user rejection',
    async (method) => {
      passkey.mockRejectedValue(new Error('NotAllowedError: The operation either timed out or was not allowed.'))
      await wc.handleSignXdrRequest(request(method, dappTxXdr()))
      expect(lastResponse().error).toEqual({ code: 5000, message: 'User rejected.' })
      expectNothingSigned()
    },
  )

  it('stops at the first refused entry when a call needs several', async () => {
    // A second entry must not be signed, nor the envelope, once the user said no.
    simAuth = () => [addressEntry(WALLET), addressEntry(WALLET)]
    passkey.mockResolvedValueOnce(null)
    await wc.handleSignXdrRequest(request('stellar_signAndSubmitXDR', dappTxXdr()))
    expect(passkey).toHaveBeenCalledTimes(1)
    expectNothingSigned()
  })

  it('surfaces an authenticator failure that is not a cancellation', async () => {
    passkey.mockRejectedValue(new Error('InvalidStateError: authenticator unavailable'))
    await wc.handleSignXdrRequest(request('stellar_signXDR', dappTxXdr()))
    expect(lastResponse().error).toEqual({ code: 5000, message: 'InvalidStateError: authenticator unavailable' })
    expectNothingSigned()
  })

  it('refuses when there is no passkey registered on this device', async () => {
    localStorage.removeItem('invisible_wallet_key_id')
    await wc.handleSignXdrRequest(request('stellar_signXDR', dappTxXdr()))
    expect(lastResponse().error).toEqual({
      code: 5000,
      message: 'No passkey found. Please register the wallet first.',
    })
    expect(passkey).not.toHaveBeenCalled()
    expectNothingSigned()
  })
})

// ── Accepted requests ─────────────────────────────────────────────────────────

describe('stellar_signXDR', () => {
  beforeEach(() => load())

  it('signs each wallet entry with the passkey before the fee payer signs the envelope', async () => {
    simAuth = () => [addressEntry(WALLET), addressEntry(WALLET)]
    await wc.handleSignXdrRequest(request('stellar_signXDR', dappTxXdr()))

    const response = lastResponse()
    expect(response.error).toBeUndefined()
    expect(response.id).toBe(42)
    expect(passkey).toHaveBeenCalledTimes(2)
    expect(txSign).toHaveBeenCalledTimes(1)
    // The order is the proof: the envelope is signed only after every passkey prompt returned.
    for (const call of passkey.mock.invocationCallOrder) {
      expect(call).toBeLessThan(txSign.mock.invocationCallOrder[0])
    }
    expect(txSign.mock.calls[0][0].publicKey()).toBe(feePayer.publicKey())
    // signXDR hands the transaction back; it must not be submitted.
    expect(rpc.sendTransaction).not.toHaveBeenCalled()

    const signed = sdk.TransactionBuilder.fromXDR(response.result.signedXDR, sdk.Networks.TESTNET) as any
    expect(signed.source).toBe(feePayer.publicKey())
    expect(signed.signatures).toHaveLength(1)
    const op = signed.operations[0]
    expect(op.auth).toHaveLength(2)
    for (const entry of op.auth) {
      const cred = entry.credentials().address()
      expect(sdk.Address.fromScAddress(cred.address()).toString()).toBe(WALLET)
      expect(cred.signatureExpirationLedger()).toBe(1100) // latest ledger + 100
      const parts = cred.signature().vec()
      // publicKey, authData, clientDataJSON, signature, nonce — what __check_auth reads.
      expect(parts).toHaveLength(5)
      expect(Buffer.from(parts[0].bytes()).toString('hex')).toBe(PASSKEY_PUBLIC_KEY_HEX)
      expect(Buffer.from(parts[3].bytes()).toString('hex')).toBe('11'.repeat(32) + '22'.repeat(32))
      expect(sdk.scValToNative(parts[4])).toBe(9n)
    }
  })

  it('asks the passkey to sign the hash of exactly the entry it attaches', async () => {
    // If the challenge and the attached credential disagreed (another nonce, another
    // expiry), __check_auth would reject, or worse, the passkey would have signed
    // something other than what is submitted.
    await wc.handleSignXdrRequest(request('stellar_signXDR', dappTxXdr()))
    const challenge = new Uint8Array(passkey.mock.calls[0][0].publicKey.challenge)
    expect(passkey.mock.calls[0][0].publicKey.userVerification).toBe('required')

    const signed = sdk.TransactionBuilder.fromXDR(lastResponse().result.signedXDR, sdk.Networks.TESTNET) as any
    const entry = signed.operations[0].auth[0]
    const cred = entry.credentials().address()
    const networkId = sdk.hash(Buffer.from(sdk.Networks.TESTNET))
    const preimage = sdk.xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new sdk.xdr.HashIdPreimageSorobanAuthorization({
        networkId,
        nonce: cred.nonce(),
        invocation: entry.rootInvocation(),
        signatureExpirationLedger: cred.signatureExpirationLedger(),
      }),
    )
    expect(Buffer.from(challenge).toString('hex')).toBe(sdk.hash(preimage.toXDR()).toString('hex'))
  })

  it('omits the nonce element when the wallet nonce cannot be read', async () => {
    const original = rpc.simulateTransaction.getMockImplementation()!
    rpc.simulateTransaction.mockImplementation(async (tx: any) => {
      const fn = tx.operations[0].func.invokeContract().functionName().toString()
      if (fn === 'get_nonce') return { id: '1', latestLedger: 1000, events: [], error: 'no nonce' }
      return original(tx)
    })
    await wc.handleSignXdrRequest(request('stellar_signXDR', dappTxXdr()))
    const signed = sdk.TransactionBuilder.fromXDR(lastResponse().result.signedXDR, sdk.Networks.TESTNET) as any
    expect(signed.operations[0].auth[0].credentials().address().signature().vec()).toHaveLength(4)
  })

  it('names a wallet-contract error from the enforce-mode re-simulation', async () => {
    const original = rpc.simulateTransaction.getMockImplementation()!
    rpc.simulateTransaction.mockImplementation(async (tx: any) => {
      if (tx.operations[0].auth?.length > 0) {
        return {
          id: '1',
          latestLedger: 1000,
          events: [],
          error: 'HostError: Error(Auth, InvalidAction) ... __check_auth ... Error(Contract, #9)',
        }
      }
      return original(tx)
    })
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    await wc.handleSignXdrRequest(request('stellar_signXDR', dappTxXdr()))
    const { error } = lastResponse()
    expect(error.code).toBe(5000)
    expect(error.message).not.toContain('HostError')
    expect(txSign).not.toHaveBeenCalled()
  })

  it.each([
    ['a bare string', (x: string) => x],
    ['an array of strings', (x: string) => [x]],
    ['an array of { xdr }', (x: string) => [{ xdr: x }]],
    ['an array of { transaction }', (x: string) => [{ transaction: x }]],
    ['{ xdr }', (x: string) => ({ xdr: x })],
    ['{ transaction }', (x: string) => ({ transaction: x })],
    ['{ tx }', (x: string) => ({ tx: x })],
  ])('accepts the XDR as %s', async (_label, wrap) => {
    // dApp libraries disagree on the param shape; each one in use must keep working.
    await wc.handleSignXdrRequest(request('stellar_signXDR', wrap(dappTxXdr())))
    expect(lastResponse().result.signedXDR).toEqual(expect.any(String))
    expect(passkey).toHaveBeenCalledTimes(1)
  })

  it('takes the request id from params.request.id when the event has none', async () => {
    const event: any = request('stellar_signXDR', dappTxXdr())
    delete event.id
    event.params.request.id = 77
    await wc.handleSignXdrRequest(event)
    expect(lastResponse().id).toBe(77)
  })
})

describe('stellar_signAndSubmitXDR', () => {
  beforeEach(() => load())

  it('submits the passkey-signed transaction and answers with its hash', async () => {
    await wc.handleSignXdrRequest(request('stellar_signAndSubmitXDR', dappTxXdr()))
    expect(lastResponse()).toEqual({ id: 42, jsonrpc: '2.0', result: { txHash: 'c'.repeat(64) } })
    expect(rpc.sendTransaction).toHaveBeenCalledTimes(1)
    expect(passkey.mock.invocationCallOrder[0]).toBeLessThan(rpc.sendTransaction.mock.invocationCallOrder[0])

    const submitted = rpc.sendTransaction.mock.calls[0][0]
    expect(submitted.source).toBe(feePayer.publicKey())
    const cred = submitted.operations[0].auth[0].credentials().address()
    expect(sdk.Address.fromScAddress(cred.address()).toString()).toBe(WALLET)
    expect(cred.signature().switch().name).toBe('scvVec')
  })

  it('reports a transaction the network rejected', async () => {
    rpc.sendTransaction.mockResolvedValue({
      status: 'ERROR',
      errorResult: { toXDR: () => 'AAAAAAAAAGT////7AAAAAA==' },
    })
    await wc.handleSignXdrRequest(request('stellar_signAndSubmitXDR', dappTxXdr()))
    expect(lastResponse().error).toEqual({
      code: 5000,
      message: 'Transaction rejected: AAAAAAAAAGT////7AAAAAA==',
    })
  })

  it('refuses when this device has no fee-payer key', async () => {
    localStorage.removeItem('veil_signer_secret')
    await wc.handleSignXdrRequest(request('stellar_signAndSubmitXDR', dappTxXdr()))
    expect(lastResponse().error).toEqual({ code: 5000, message: 'No fee-payer signer secret found in storage.' })
    expect(passkey).not.toHaveBeenCalled()
    expectNothingSigned()
  })
})

// ── Session lifecycle ─────────────────────────────────────────────────────────

describe('session lifecycle', () => {
  it('will not start without a project id', async () => {
    await load({ init: false })
    delete process.env.NEXT_PUBLIC_WC_PROJECT_ID
    await expect(wc.getWalletConnectClient()).rejects.toThrow('NEXT_PUBLIC_WC_PROJECT_ID is missing.')
  })

  it('initialises once and reuses the client', async () => {
    await load()
    const { WalletKit } = require('@reown/walletkit')
    expect(await wc.getWalletConnectClient()).toBe(client)
    expect(WalletKit.init).toHaveBeenCalledTimes(1)
    expect(Object.keys(client.handlers).sort()).toEqual([
      'proposal_expire',
      'session_delete',
      'session_proposal',
      'session_request',
    ])
  })

  it('lists live sessions from the client and leaves out expired ones', async () => {
    await load({ init: false })
    client.active['topic-2'] = rawSession('topic-2', { expiry: Math.floor(Date.now() / 1000) - 60 })
    await wc.getWalletConnectClient()
    expect(wc.getWalletConnectSessions()).toEqual([
      {
        topic: 'topic-1',
        chainId: TESTNET,
        account: `${TESTNET}:${WALLET}`,
        peer: { name: 'Test dApp', url: 'https://dapp.test' },
        expiry: client.active['topic-1'].expiry,
      },
    ])
    expect(JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY)!)).toHaveLength(1)
  })

  it('restores stored sessions before the client is ready, minus expired ones', async () => {
    await load({ init: false })
    const now = Math.floor(Date.now() / 1000)
    sessionStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify([
        { topic: 'kept', chainId: TESTNET, account: `${TESTNET}:${WALLET}`, peer: null, expiry: now + 60 },
        { topic: 'legacy', chainId: TESTNET, account: `${TESTNET}:${WALLET}`, peer: null },
        { topic: 'gone', chainId: TESTNET, account: `${TESTNET}:${WALLET}`, peer: null, expiry: now - 60 },
      ]),
    )
    const first: string[][] = []
    wc.subscribeWalletConnectSessions((s) => first.push(s.map((x) => x.topic)))
    const { WalletKit } = require('@reown/walletkit')
    WalletKit.init.mockImplementation(async () => {
      // What the UI shows while the relay connects.
      expect(first[first.length - 1]).toEqual(['kept', 'legacy'])
      return client
    })
    await wc.getWalletConnectClient()
    expect(first[first.length - 1]).toEqual(['topic-1'])
  })

  it('treats unreadable stored sessions as none', async () => {
    await load({ init: false })
    sessionStorage.setItem(SESSION_STORAGE_KEY, '{not json')
    client.active = {} as any
    client.getActiveSessions.mockReturnValue({})
    await wc.getWalletConnectClient()
    expect(wc.getWalletConnectSessions()).toEqual([])
  })

  it('holds a proposal until it is approved, and approves it for this network and wallet only', async () => {
    await load()
    const proposals: unknown[] = []
    wc.subscribeWalletConnectProposal((p) => proposals.push(p))
    const proposal = { id: 9, proposer: { metadata: { name: 'Test dApp' } } }
    client.handlers.session_proposal(proposal)
    expect(wc.getPendingWalletConnectProposal()).toBe(proposal)

    client.active['topic-9'] = rawSession('topic-9')
    await wc.approveSession(proposal, WALLET)
    expect(client.approveSession).toHaveBeenCalledWith({
      id: 9,
      namespaces: {
        stellar: {
          methods: [
            'stellar_signXDR',
            'stellar_signAndSubmitXDR',
            'stellar_signAuthEntry',
            'stellar_signMessage',
            'stellar_getAccount',
            'stellar_getAddress',
            'stellar_getNetwork',
          ],
          chains: [TESTNET],
          events: ['accountsChanged', 'chainChanged'],
          accounts: [`${TESTNET}:${WALLET}`],
        },
      },
    })
    expect(wc.getPendingWalletConnectProposal()).toBeNull()
    expect(proposals).toEqual([null, proposal, null])
    expect(wc.getWalletConnectSessions().map((s) => s.topic)).toEqual(['topic-1', 'topic-9'])
  })

  it('will not approve a session for anything but a contract address', async () => {
    // A G-address here would hand the dApp the fee payer as "the wallet".
    await load()
    await expect(wc.approveSession({ id: 9 }, feePayer.publicKey())).rejects.toThrow(
      'Wallet address must be a Stellar contract address (C...).',
    )
    expect(client.approveSession).not.toHaveBeenCalled()
  })

  it('rejects a proposal as a user rejection and clears it', async () => {
    await load()
    client.handlers.session_proposal({ id: 9 })
    await wc.rejectSession({ id: 9 })
    expect(client.rejectSession).toHaveBeenCalledWith({
      id: 9,
      reason: { code: 5000, message: 'User rejected.' },
    })
    expect(wc.getPendingWalletConnectProposal()).toBeNull()
  })

  it('drops a pending proposal when it expires, and only that one', async () => {
    await load()
    client.handlers.session_proposal({ id: 9 })
    client.handlers.proposal_expire({ id: 8 })
    expect(wc.getPendingWalletConnectProposal()).toEqual({ id: 9 })
    client.handlers.proposal_expire({ id: 9 })
    expect(wc.getPendingWalletConnectProposal()).toBeNull()
  })

  it('forgets a session the dApp deleted', async () => {
    await load()
    client.handlers.session_delete({ topic: 'topic-1' })
    expect(wc.getWalletConnectSessions()).toEqual([])
    expect(JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY)!)).toEqual([])
  })

  it('disconnects one session', async () => {
    await load()
    await wc.disconnectSession('topic-1')
    expect(client.disconnectSession).toHaveBeenCalledWith({
      topic: 'topic-1',
      reason: { code: 6000, message: 'User disconnected.' },
    })
    expect(wc.getWalletConnectSessions()).toEqual([])
  })

  it('disconnects every session even when one disconnect fails', async () => {
    // Used on lock and reset: one dead relay topic must not leave the others connected.
    await load({ init: false })
    client.active['topic-2'] = rawSession('topic-2')
    await wc.getWalletConnectClient()
    client.disconnectSession.mockRejectedValueOnce(new Error('relay down'))
    await wc.disconnectAllSessions()
    expect(client.disconnectSession).toHaveBeenCalledTimes(2)
    expect(wc.getWalletConnectSessions()).toEqual([])
    expect(JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY)!)).toEqual([])
  })

  it('pairs with a URI through the client', async () => {
    await load()
    await wc.pairWalletConnect('wc:abc@2?relay-protocol=irn&symKey=def')
    expect(client.pair).toHaveBeenCalledWith({ uri: 'wc:abc@2?relay-protocol=irn&symKey=def' })
  })

  it('stops notifying a listener after it unsubscribes', async () => {
    await load()
    const listener = jest.fn()
    const unsubscribe = wc.subscribeWalletConnectSessions(listener)
    unsubscribe()
    client.handlers.session_delete({ topic: 'topic-1' })
    expect(listener).toHaveBeenCalledTimes(1) // the immediate call on subscribe only
  })
})
