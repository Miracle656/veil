/**
 * @jest-environment node
 *
 * Unit tests for `walletInvoke.ts` — the seven-step passkey spend path.
 *
 * Only `rpc.Server` from `@stellar/stellar-sdk` is mocked; every XDR value,
 * `TransactionBuilder`, `Contract`, `scValToNative`, `nativeToScVal`, and
 * `rpc.assembleTransaction` runs for real so that malformed XDR or mismatched
 * preimages are caught by the SDK itself. No real network or funded key is used.
 */

import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  Transaction,
  nativeToScVal,
  rpc as SorobanRpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'
import type { WebAuthnSignature } from '@veil/sdk'

import {
  describeFailure,
  getWalletNonce,
  invokeAsFeePayer,
  invokeAsWallet,
  type AuthEntrySigner,
} from '../walletInvoke'
import { WRONG_PLATFORM_ERROR_MESSAGE } from '../platformLimitation'

// ── Mock only rpc.Server; keep every real SDK XDR / builder / assembler ───────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
jest.mock('@stellar/stellar-sdk', (): any => {
  const actual = jest.requireActual('@stellar/stellar-sdk')
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: jest.fn(),
    },
  }
})

const MockServer = SorobanRpc.Server as unknown as jest.Mock

// ── Test fixtures (synthetic keys & addresses; never funded or on mainnet) ────

const TESTNET = Networks.TESTNET
const RPC_URL = 'https://mock-soroban-rpc.invalid'
const WALLET_ADDRESS = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4'
const TARGET_CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'
const FEE_PAYER_KP = Keypair.random()
const FAKE_TX_HASH = 'a'.repeat(64)

const FAKE_WEBAUTHN_SIG: WebAuthnSignature = {
  publicKey: new Uint8Array(65).fill(0x04),
  authData: new Uint8Array(37).fill(0x11),
  clientDataJSON: new TextEncoder().encode(
    '{"type":"webauthn.get","challenge":"test","origin":"https://app.useveilapp.xyz"}',
  ),
  signature: new Uint8Array(64).fill(0x22),
}

// ── Real XDR builders ─────────────────────────────────────────────────────────

function buildTransactionDataXdr(opts: {
  resourceFee?: string
  instructions?: number
  readOnlyKeys?: xdr.LedgerKey[]
  readWriteKeys?: xdr.LedgerKey[]
} = {}): string {
  return new xdr.SorobanTransactionData({
    ext: new xdr.SorobanTransactionDataExt(0),
    resources: new xdr.SorobanResources({
      footprint: new xdr.LedgerFootprint({
        readOnly: opts.readOnlyKeys ?? [],
        readWrite: opts.readWriteKeys ?? [],
      }),
      instructions: opts.instructions ?? 100_000,
      diskReadBytes: 0,
      writeBytes: 0,
    }),
    resourceFee: xdr.Int64.fromString(opts.resourceFee ?? '100'),
  }).toXDR('base64')
}

function buildAddressAuthEntry(opts: {
  address?: string
  nonce?: string
  functionName?: string
  signatureExpirationLedger?: number
} = {}): xdr.SorobanAuthorizationEntry {
  const contractFn = new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(TARGET_CONTRACT_ID).toScAddress(),
    functionName: opts.functionName ?? 'transfer',
    args: [],
  })
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(contractFn),
    subInvocations: [],
  })
  const raw = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(opts.address ?? WALLET_ADDRESS).toScAddress(),
        nonce: xdr.Int64.fromString(opts.nonce ?? '42'),
        signatureExpirationLedger: opts.signatureExpirationLedger ?? 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: invocation,
  })
  return xdr.SorobanAuthorizationEntry.fromXDR(raw.toXDR('base64'), 'base64')
}

function buildSourceAccountAuthEntry(functionName = 'transfer'): xdr.SorobanAuthorizationEntry {
  const contractFn = new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(TARGET_CONTRACT_ID).toScAddress(),
    functionName,
    args: [],
  })
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(contractFn),
    subInvocations: [],
  })
  const raw = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: invocation,
  })
  return xdr.SorobanAuthorizationEntry.fromXDR(raw.toXDR('base64'), 'base64')
}

function buildSimSuccess(opts: {
  retval?: xdr.ScVal
  auth?: xdr.SorobanAuthorizationEntry[]
  minResourceFee?: string
  transactionDataXdr?: string
  latestLedger?: number
} = {}): SorobanRpc.Api.SimulateTransactionSuccessResponse {
  // Pass real base64 XDR through the SDK's own parser so every byte is decoded
  // and `_parsed: true` is set for `assembleTransaction`.
  return SorobanRpc.parseRawSimulation({
    id: 'sim-1',
    latestLedger: opts.latestLedger ?? 1000,
    events: [],
    minResourceFee: opts.minResourceFee ?? '100',
    transactionData: opts.transactionDataXdr ?? buildTransactionDataXdr(),
    results: [
      {
        auth: (opts.auth ?? []).map((entry) => entry.toXDR('base64')),
        xdr: (opts.retval ?? xdr.ScVal.scvVoid()).toXDR('base64'),
      },
    ],
  }) as SorobanRpc.Api.SimulateTransactionSuccessResponse
}

function buildSimError(error: string, latestLedger = 1000): SorobanRpc.Api.SimulateTransactionErrorResponse {
  return SorobanRpc.parseRawSimulation({
    id: 'sim-err',
    latestLedger,
    events: [],
    error,
  }) as SorobanRpc.Api.SimulateTransactionErrorResponse
}

function buildContractInstanceKey(contractId: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  )
}

function buildDiagnosticContractErrorMeta(
  contractCode: number,
  metaVersion: 3 | 4 = 3,
): xdr.TransactionMeta {
  const diagEvent = new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: null,
      type: xdr.ContractEventType.diagnostic(),
      body: new xdr.ContractEventBody(
        0,
        new xdr.ContractEventV0({
          topics: [
            xdr.ScVal.scvSymbol('error'),
            xdr.ScVal.scvError(xdr.ScError.sceContract(contractCode)),
          ],
          data: xdr.ScVal.scvVoid(),
        }),
      ),
    }),
  })

  if (metaVersion === 4) {
    const raw = new xdr.TransactionMeta(
      4,
      new xdr.TransactionMetaV4({
        ext: new xdr.ExtensionPoint(0),
        txChangesBefore: [],
        operations: [],
        txChangesAfter: [],
        sorobanMeta: new xdr.SorobanTransactionMetaV2({
          ext: new xdr.SorobanTransactionMetaExt(0),
          returnValue: xdr.ScVal.scvVoid(),
        }),
        events: [],
        diagnosticEvents: [diagEvent],
      }),
    )
    return xdr.TransactionMeta.fromXDR(raw.toXDR('base64'), 'base64')
  }

  const raw = new xdr.TransactionMeta(
    3,
    new xdr.TransactionMetaV3({
      ext: new xdr.ExtensionPoint(0),
      txChangesBefore: [],
      operations: [],
      txChangesAfter: [],
      sorobanMeta: new xdr.SorobanTransactionMeta({
        ext: new xdr.SorobanTransactionMetaExt(0),
        events: [],
        returnValue: xdr.ScVal.scvVoid(),
        diagnosticEvents: [diagEvent],
      }),
    }),
  )
  return xdr.TransactionMeta.fromXDR(raw.toXDR('base64'), 'base64')
}

function buildErrorTransactionResult(): xdr.TransactionResult {
  const raw = new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString('100'),
    result: xdr.TransactionResultResult.txFailed([]),
    ext: new xdr.TransactionResultExt(0),
  })
  return xdr.TransactionResult.fromXDR(raw.toXDR('base64'), 'base64')
}

// ── Mock RPC factory ──────────────────────────────────────────────────────────

interface MockRpc {
  simulateTransaction: jest.Mock
  getAccount: jest.Mock
  getLatestLedger: jest.Mock
  sendTransaction: jest.Mock
  getTransaction: jest.Mock
}

function createMockRpc(overrides: Partial<MockRpc> = {}): MockRpc {
  const rpc: MockRpc = {
    simulateTransaction: jest.fn(),
    getAccount: jest.fn().mockImplementation(async (pubKey: string) => new Account(pubKey, '100')),
    getLatestLedger: jest.fn().mockResolvedValue({
      id: 'e'.repeat(64),
      protocolVersion: 22,
      sequence: 5000,
    }),
    sendTransaction: jest.fn().mockResolvedValue({
      status: 'PENDING',
      hash: FAKE_TX_HASH,
      latestLedger: 5000,
      latestLedgerCloseTime: '0',
    }),
    getTransaction: jest.fn().mockResolvedValue({
      status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
      latestLedger: 5001,
    }),
    ...overrides,
  }
  MockServer.mockImplementation(() => rpc)
  return rpc
}

// ── Shared helpers ────────────────────────────────────────────────────────────

async function computeExpectedAuthPayloadHash(params: {
  networkPassphrase: string
  nonce: xdr.Int64
  invocation: xdr.SorobanAuthorizedInvocation
  signatureExpirationLedger: number
}): Promise<Uint8Array> {
  const networkIdBytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(params.networkPassphrase)),
  )
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: Buffer.from(networkIdBytes),
      nonce: params.nonce,
      invocation: params.invocation,
      signatureExpirationLedger: params.signatureExpirationLedger,
    }),
  )
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(preimage.toXDR())))
}

/** Extract the InvokeHostFunction auth entries from a submitted Transaction. */
function extractSubmittedAuth(tx: Transaction): xdr.SorobanAuthorizationEntry[] {
  const op = tx.operations[0] as Operation.InvokeHostFunction
  return op.auth ?? []
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('walletInvoke', () => {
  let consoleErrorSpy: jest.SpyInstance
  let consoleWarnSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.useRealTimers()
    consoleErrorSpy.mockRestore()
    consoleWarnSpy.mockRestore()
  })

  // ── getWalletNonce ──────────────────────────────────────────────────────────

  describe('getWalletNonce', () => {
    it('returns the bigint nonce when get_nonce succeeds', async () => {
      const rpc = createMockRpc({
        simulateTransaction: jest.fn().mockResolvedValue(
          buildSimSuccess({ retval: nativeToScVal(7n, { type: 'u64' }) }),
        ),
      })

      const nonce = await getWalletNonce(
        rpc as unknown as SorobanRpc.Server,
        WALLET_ADDRESS,
        TESTNET,
      )

      expect(nonce).toBe(7n)
      expect(rpc.simulateTransaction).toHaveBeenCalledTimes(1)
    })

    it('returns null when simulation returns an error', async () => {
      const rpc = createMockRpc({
        simulateTransaction: jest.fn().mockResolvedValue(
          buildSimError('HostError: Error(Contract, #1) missing function get_nonce'),
        ),
      })

      const nonce = await getWalletNonce(
        rpc as unknown as SorobanRpc.Server,
        WALLET_ADDRESS,
        TESTNET,
      )

      expect(nonce).toBeNull()
    })

    it('returns null when simulation succeeds without retval', async () => {
      const rpc = createMockRpc({
        simulateTransaction: jest.fn().mockResolvedValue({
          _parsed: true,
          id: 'sim-no-retval',
          latestLedger: 1000,
          events: [],
          minResourceFee: '100',
          transactionData: new SorobanDataBuilder(buildTransactionDataXdr()),
          result: { auth: [] },
        }),
      })

      const nonce = await getWalletNonce(
        rpc as unknown as SorobanRpc.Server,
        WALLET_ADDRESS,
        TESTNET,
      )

      expect(nonce).toBeNull()
    })

    it('returns null when the RPC throws', async () => {
      const rpc = createMockRpc({
        simulateTransaction: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      })

      const nonce = await getWalletNonce(
        rpc as unknown as SorobanRpc.Server,
        WALLET_ADDRESS,
        TESTNET,
      )

      expect(nonce).toBeNull()
    })
  })

  // ── invokeAsWallet ──────────────────────────────────────────────────────────

  describe('invokeAsWallet', () => {
    it('builds a 4-element signature vector when nonce is null (legacy wallet WASM)', async () => {
      const authEntry = buildAddressAuthEntry({ nonce: '99' })
      const rpc = createMockRpc()
      rpc.simulateTransaction
        // 1. getWalletNonce probe -> error (legacy contract without get_nonce)
        .mockResolvedValueOnce(buildSimError('missing function get_nonce'))
        // 2. recording-mode simulation
        .mockResolvedValueOnce(buildSimSuccess({ auth: [authEntry] }))
        // 3. enforce-mode re-simulation
        .mockResolvedValueOnce(buildSimSuccess({ auth: [authEntry] }))

      const signAuthEntry: AuthEntrySigner = jest.fn().mockResolvedValue(FAKE_WEBAUTHN_SIG)

      const hash = await invokeAsWallet({
        contractId: TARGET_CONTRACT_ID,
        method: 'transfer',
        args: [nativeToScVal(100n, { type: 'i128' })],
        walletAddress: WALLET_ADDRESS,
        feePayerKeypair: FEE_PAYER_KP,
        signAuthEntry,
        rpcUrl: RPC_URL,
        networkPassphrase: TESTNET,
      })

      expect(hash).toBe(FAKE_TX_HASH)

      // Inspect the auth entry passed into the enforce-mode re-simulation (3rd call)
      const signedTx = rpc.simulateTransaction.mock.calls[2][0] as Transaction
      const signedAuth = extractSubmittedAuth(signedTx)
      expect(signedAuth).toHaveLength(1)

      const sigVec = signedAuth[0].credentials().address().signature().vec()
      expect(sigVec).toHaveLength(4)
      expect(Buffer.from(sigVec![0].bytes())).toEqual(Buffer.from(FAKE_WEBAUTHN_SIG.publicKey))
      expect(Buffer.from(sigVec![1].bytes())).toEqual(Buffer.from(FAKE_WEBAUTHN_SIG.authData))
      expect(Buffer.from(sigVec![2].bytes())).toEqual(Buffer.from(FAKE_WEBAUTHN_SIG.clientDataJSON))
      expect(Buffer.from(sigVec![3].bytes())).toEqual(Buffer.from(FAKE_WEBAUTHN_SIG.signature))
    })

    it('builds a 5-element signature vector with nonce last as u64 when nonce is present', async () => {
      const walletNonce = 123456789012345n
      const authEntry = buildAddressAuthEntry({ nonce: '55' })
      const rpc = createMockRpc()
      rpc.simulateTransaction
        // 1. getWalletNonce probe -> bigint nonce
        .mockResolvedValueOnce(
          buildSimSuccess({ retval: nativeToScVal(walletNonce, { type: 'u64' }) }),
        )
        // 2. recording-mode simulation
        .mockResolvedValueOnce(buildSimSuccess({ auth: [authEntry] }))
        // 3. enforce-mode re-simulation
        .mockResolvedValueOnce(buildSimSuccess({ auth: [authEntry] }))

      const signAuthEntry: AuthEntrySigner = jest.fn().mockResolvedValue(FAKE_WEBAUTHN_SIG)

      await invokeAsWallet({
        contractId: TARGET_CONTRACT_ID,
        method: 'transfer',
        args: [],
        walletAddress: WALLET_ADDRESS,
        feePayerKeypair: FEE_PAYER_KP,
        signAuthEntry,
        rpcUrl: RPC_URL,
        networkPassphrase: TESTNET,
      })

      const signedTx = rpc.simulateTransaction.mock.calls[2][0] as Transaction
      const signedAuth = extractSubmittedAuth(signedTx)
      const sigVec = signedAuth[0].credentials().address().signature().vec()

      expect(sigVec).toHaveLength(5)
      expect(sigVec![4].switch().name).toBe('scvU64')
      expect(scValToNative(sigVec![4])).toBe(walletNonce)
    })

    it('uses latestLedger.sequence + 100 as signatureExpirationLedger in both the signed preimage and the credential', async () => {
      const latestSequence = 77_000
      const expectedExpiration = latestSequence + 100
      const authEntry = buildAddressAuthEntry({
        nonce: '314159',
        signatureExpirationLedger: 0, // recording mode returns 0
      })
      // Snapshot the original nonce & invocation before invokeAsWallet mutates authEntry
      const origNonce = authEntry.credentials().address().nonce()
      const origInvocation = authEntry.rootInvocation()

      const rpc = createMockRpc({
        getLatestLedger: jest.fn().mockResolvedValue({
          id: 'e'.repeat(64),
          protocolVersion: 22,
          sequence: latestSequence,
        }),
      })
      rpc.simulateTransaction
        .mockResolvedValueOnce(buildSimError('no nonce'))
        .mockResolvedValueOnce(buildSimSuccess({ auth: [authEntry] }))
        .mockResolvedValueOnce(buildSimSuccess({ auth: [authEntry] }))

      let receivedPayloadHash: Uint8Array | null = null
      const signAuthEntry: AuthEntrySigner = jest.fn().mockImplementation(async (payload) => {
        receivedPayloadHash = payload
        return FAKE_WEBAUTHN_SIG
      })

      await invokeAsWallet({
        contractId: TARGET_CONTRACT_ID,
        method: 'transfer',
        args: [],
        walletAddress: WALLET_ADDRESS,
        feePayerKeypair: FEE_PAYER_KP,
        signAuthEntry,
        rpcUrl: RPC_URL,
        networkPassphrase: TESTNET,
      })

      const expectedHash = await computeExpectedAuthPayloadHash({
        networkPassphrase: TESTNET,
        nonce: origNonce,
        invocation: origInvocation,
        signatureExpirationLedger: expectedExpiration,
      })

      expect(receivedPayloadHash).not.toBeNull()
      expect(Buffer.from(receivedPayloadHash!)).toEqual(Buffer.from(expectedHash))

      // Verify the credential attached to the re-simulated & submitted tx has the exact same expiration
      const signedTx = rpc.simulateTransaction.mock.calls[2][0] as Transaction
      const signedAuth = extractSubmittedAuth(signedTx)
      expect(signedAuth[0].credentials().address().signatureExpirationLedger()).toBe(
        expectedExpiration,
      )
    })

    it('calls simulateTransaction twice for the invocation and assembles the submitted transaction from the second result', async () => {
      const authEntry = buildAddressAuthEntry({ nonce: '1' })

      // Distinct footprints and fees for recording-mode (sim1) vs enforce-mode (sim2)
      const sim1DataXdr = buildTransactionDataXdr({
        resourceFee: '1000',
        instructions: 111_111,
        readOnlyKeys: [],
      })
      const sim2DataXdr = buildTransactionDataXdr({
        resourceFee: '99999',
        instructions: 888_888,
        readOnlyKeys: [buildContractInstanceKey(WALLET_ADDRESS)],
      })

      const rpc = createMockRpc()
      rpc.simulateTransaction
        // Call 0: getWalletNonce probe
        .mockResolvedValueOnce(buildSimSuccess({ retval: nativeToScVal(0n, { type: 'u64' }) }))
        // Call 1: recording-mode simulation (sim1)
        .mockResolvedValueOnce(
          buildSimSuccess({
            auth: [authEntry],
            minResourceFee: '1000',
            transactionDataXdr: sim1DataXdr,
          }),
        )
        // Call 2: enforce-mode re-simulation (sim2)
        .mockResolvedValueOnce(
          buildSimSuccess({
            auth: [authEntry],
            minResourceFee: '99999',
            transactionDataXdr: sim2DataXdr,
          }),
        )

      const signAuthEntry: AuthEntrySigner = jest.fn().mockResolvedValue(FAKE_WEBAUTHN_SIG)

      await invokeAsWallet({
        contractId: TARGET_CONTRACT_ID,
        method: 'transfer',
        args: [],
        walletAddress: WALLET_ADDRESS,
        feePayerKeypair: FEE_PAYER_KP,
        signAuthEntry,
        rpcUrl: RPC_URL,
        networkPassphrase: TESTNET,
      })

      // 1 nonce probe + 2 invocation simulations = 3 total calls
      expect(rpc.simulateTransaction).toHaveBeenCalledTimes(3)
      // First invocation sim receives cpuInstructions option; second does not
      expect(rpc.simulateTransaction.mock.calls[1][1]).toEqual({ cpuInstructions: 5_000_000 })
      expect(rpc.simulateTransaction.mock.calls[2][1]).toBeUndefined()

      // Inspect the assembled transaction actually sent to rpc.sendTransaction
      expect(rpc.sendTransaction).toHaveBeenCalledTimes(1)
      const submittedTx = rpc.sendTransaction.mock.calls[0][0] as Transaction
      const envelopeData = submittedTx.toEnvelope().v1().tx().ext().sorobanData()

      expect(envelopeData.resources().instructions()).toBe(888_888)
      expect(envelopeData.resourceFee().toString()).toBe('99999')
      expect(envelopeData.resources().footprint().readOnly()).toHaveLength(1)
      // Total fee includes inclusionFee (100 on testnet) + sim2 minResourceFee (99999)
      expect(Number(submittedTx.fee)).toBeGreaterThanOrEqual(99999 + 100)
    })

    it('skips auth entries that are not address credentials', async () => {
      const sourceEntry = buildSourceAccountAuthEntry('transfer')
      const addressEntry = buildAddressAuthEntry({ nonce: '7' })

      const rpc = createMockRpc()
      rpc.simulateTransaction
        .mockResolvedValueOnce(buildSimError('no nonce'))
        .mockResolvedValueOnce(buildSimSuccess({ auth: [sourceEntry, addressEntry] }))
        .mockResolvedValueOnce(buildSimSuccess({ auth: [sourceEntry, addressEntry] }))

      const signAuthEntry: AuthEntrySigner = jest.fn().mockResolvedValue(FAKE_WEBAUTHN_SIG)

      await invokeAsWallet({
        contractId: TARGET_CONTRACT_ID,
        method: 'transfer',
        args: [],
        walletAddress: WALLET_ADDRESS,
        feePayerKeypair: FEE_PAYER_KP,
        signAuthEntry,
        rpcUrl: RPC_URL,
        networkPassphrase: TESTNET,
      })

      // Signer called only once — for the address credential, not the source-account entry
      expect(signAuthEntry).toHaveBeenCalledTimes(1)

      const signedTx = rpc.simulateTransaction.mock.calls[2][0] as Transaction
      const signedAuth = extractSubmittedAuth(signedTx)
      expect(signedAuth).toHaveLength(2)
      expect(signedAuth[0].credentials().switch().name).toBe('sorobanCredentialsSourceAccount')
      expect(signedAuth[1].credentials().switch().name).toBe('sorobanCredentialsAddress')
      expect(signedAuth[1].credentials().address().signature().vec()).toHaveLength(4)
    })

    it('throws "WebAuthn signing was cancelled" and never calls sendTransaction when signer returns null', async () => {
      const authEntry = buildAddressAuthEntry({ nonce: '10' })
      const rpc = createMockRpc()
      rpc.simulateTransaction
        .mockResolvedValueOnce(buildSimError('no nonce'))
        .mockResolvedValueOnce(buildSimSuccess({ auth: [authEntry] }))

      const signAuthEntry: AuthEntrySigner = jest.fn().mockResolvedValue(null)

      await expect(
        invokeAsWallet({
          contractId: TARGET_CONTRACT_ID,
          method: 'transfer',
          args: [],
          walletAddress: WALLET_ADDRESS,
          feePayerKeypair: FEE_PAYER_KP,
          signAuthEntry,
          rpcUrl: RPC_URL,
          networkPassphrase: TESTNET,
        }),
      ).rejects.toThrow('WebAuthn signing was cancelled')

      expect(rpc.sendTransaction).not.toHaveBeenCalled()
      // Enforce-mode re-simulation should also never run after cancellation
      expect(rpc.simulateTransaction).toHaveBeenCalledTimes(2)
    })

    it('throws the named sentence for a recognisable walletContractErrorMessage on first simulation', async () => {
      const rpc = createMockRpc()
      rpc.simulateTransaction
        .mockResolvedValueOnce(buildSimError('no nonce'))
        .mockResolvedValueOnce(
          buildSimError('HostError: Error(Auth, InvalidAction) __check_auth Error(Contract, #9)'),
        )

      await expect(
        invokeAsWallet({
          contractId: TARGET_CONTRACT_ID,
          method: 'transfer',
          args: [],
          walletAddress: WALLET_ADDRESS,
          feePayerKeypair: FEE_PAYER_KP,
          signAuthEntry: jest.fn(),
          rpcUrl: RPC_URL,
          networkPassphrase: TESTNET,
        }),
      ).rejects.toThrow(WRONG_PLATFORM_ERROR_MESSAGE)

      expect(rpc.sendTransaction).not.toHaveBeenCalled()
    })

    it('keeps the raw simulation error text when walletContractErrorMessage cannot name it (first simulation)', async () => {
      const rawError = 'HostError: Error(Budget, ExceededLimit) out of cpu'
      const rpc = createMockRpc()
      rpc.simulateTransaction
        .mockResolvedValueOnce(buildSimError('no nonce'))
        .mockResolvedValueOnce(buildSimError(rawError))

      await expect(
        invokeAsWallet({
          contractId: TARGET_CONTRACT_ID,
          method: 'transfer',
          args: [],
          walletAddress: WALLET_ADDRESS,
          feePayerKeypair: FEE_PAYER_KP,
          signAuthEntry: jest.fn(),
          rpcUrl: RPC_URL,
          networkPassphrase: TESTNET,
        }),
      ).rejects.toThrow(`Simulation failed: ${rawError}`)
    })

    it('throws the named sentence on enforce-mode re-simulation error when walletContractErrorMessage recognises it', async () => {
      const authEntry = buildAddressAuthEntry({ nonce: '1' })
      const rpc = createMockRpc()
      rpc.simulateTransaction
        .mockResolvedValueOnce(buildSimError('no nonce'))
        .mockResolvedValueOnce(buildSimSuccess({ auth: [authEntry] }))
        .mockResolvedValueOnce(
          buildSimError('HostError: Error(Auth, InvalidAction) Error(Contract, #16)'),
        )

      await expect(
        invokeAsWallet({
          contractId: TARGET_CONTRACT_ID,
          method: 'transfer',
          args: [],
          walletAddress: WALLET_ADDRESS,
          feePayerKeypair: FEE_PAYER_KP,
          signAuthEntry: jest.fn().mockResolvedValue(FAKE_WEBAUTHN_SIG),
          rpcUrl: RPC_URL,
          networkPassphrase: TESTNET,
        }),
      ).rejects.toThrow(
        'Something else moved funds from this wallet since this screen loaded. Reload and try again.',
      )

      expect(rpc.sendTransaction).not.toHaveBeenCalled()
    })

    it('keeps the raw error text on enforce-mode re-simulation when walletContractErrorMessage cannot name it', async () => {
      const authEntry = buildAddressAuthEntry({ nonce: '1' })
      const rawError = 'HostError: Error(Storage, MissingValue) unknown failure'
      const rpc = createMockRpc()
      rpc.simulateTransaction
        .mockResolvedValueOnce(buildSimError('no nonce'))
        .mockResolvedValueOnce(buildSimSuccess({ auth: [authEntry] }))
        .mockResolvedValueOnce(buildSimError(rawError))

      await expect(
        invokeAsWallet({
          contractId: TARGET_CONTRACT_ID,
          method: 'transfer',
          args: [],
          walletAddress: WALLET_ADDRESS,
          feePayerKeypair: FEE_PAYER_KP,
          signAuthEntry: jest.fn().mockResolvedValue(FAKE_WEBAUTHN_SIG),
          rpcUrl: RPC_URL,
          networkPassphrase: TESTNET,
        }),
      ).rejects.toThrow(`Re-simulation (enforce mode) failed: ${rawError}`)

      expect(rpc.sendTransaction).not.toHaveBeenCalled()
    })

    it('throws when sendTransaction returns status ERROR', async () => {
      const authEntry = buildAddressAuthEntry({ nonce: '1' })
      const errResult = buildErrorTransactionResult()
      const rpc = createMockRpc({
        sendTransaction: jest.fn().mockResolvedValue({
          status: 'ERROR',
          errorResult: errResult,
          latestLedger: 5000,
          latestLedgerCloseTime: '0',
        }),
      })
      rpc.simulateTransaction
        .mockResolvedValueOnce(buildSimError('no nonce'))
        .mockResolvedValueOnce(buildSimSuccess({ auth: [authEntry] }))
        .mockResolvedValueOnce(buildSimSuccess({ auth: [authEntry] }))

      await expect(
        invokeAsWallet({
          contractId: TARGET_CONTRACT_ID,
          method: 'transfer',
          args: [],
          walletAddress: WALLET_ADDRESS,
          feePayerKeypair: FEE_PAYER_KP,
          signAuthEntry: jest.fn().mockResolvedValue(FAKE_WEBAUTHN_SIG),
          rpcUrl: RPC_URL,
          networkPassphrase: TESTNET,
        }),
      ).rejects.toThrow(`Transaction rejected: ${errResult.toXDR('base64')}`)
    })

    it('throws when polled transaction status is FAILED', async () => {
      const authEntry = buildAddressAuthEntry({ nonce: '1' })
      const rpc = createMockRpc({
        getTransaction: jest.fn().mockResolvedValue({
          status: SorobanRpc.Api.GetTransactionStatus.FAILED,
          resultMetaXdr: buildDiagnosticContractErrorMeta(7),
        }),
      })
      rpc.simulateTransaction
        .mockResolvedValueOnce(buildSimError('no nonce'))
        .mockResolvedValueOnce(buildSimSuccess({ auth: [authEntry] }))
        .mockResolvedValueOnce(buildSimSuccess({ auth: [authEntry] }))

      await expect(
        invokeAsWallet({
          contractId: TARGET_CONTRACT_ID,
          method: 'transfer',
          args: [],
          walletAddress: WALLET_ADDRESS,
          feePayerKeypair: FEE_PAYER_KP,
          signAuthEntry: jest.fn().mockResolvedValue(FAKE_WEBAUTHN_SIG),
          rpcUrl: RPC_URL,
          networkPassphrase: TESTNET,
        }),
      ).rejects.toThrow('Transaction failed: FAILED | sceContract=7')
    })

    it('throws the timeout error when getTransaction never leaves NOT_FOUND (using fake timers)', async () => {
      jest.useFakeTimers()

      let resolveSent!: () => void
      const sent = new Promise<void>((r) => {
        resolveSent = r
      })

      const authEntry = buildAddressAuthEntry({ nonce: '1' })
      const rpc = createMockRpc({
        sendTransaction: jest.fn().mockImplementation(async () => {
          resolveSent()
          return {
            status: 'PENDING',
            hash: FAKE_TX_HASH,
            latestLedger: 5000,
            latestLedgerCloseTime: '0',
          }
        }),
        getTransaction: jest.fn().mockResolvedValue({
          status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND,
          latestLedger: 5000,
        }),
      })
      rpc.simulateTransaction
        .mockResolvedValueOnce(buildSimError('no nonce'))
        .mockResolvedValueOnce(buildSimSuccess({ auth: [authEntry] }))
        .mockResolvedValueOnce(buildSimSuccess({ auth: [authEntry] }))

      const promise = invokeAsWallet({
        contractId: TARGET_CONTRACT_ID,
        method: 'transfer',
        args: [],
        walletAddress: WALLET_ADDRESS,
        feePayerKeypair: FEE_PAYER_KP,
        signAuthEntry: jest.fn().mockResolvedValue(FAKE_WEBAUTHN_SIG),
        rpcUrl: RPC_URL,
        networkPassphrase: TESTNET,
      })

      // Attach rejection handler before advancing timers so Node never flags an unhandled rejection.
      const assertion = expect(promise).rejects.toThrow(
        'Transaction timed out — check status manually',
      )

      // Wait for crypto.subtle.digest and submission to reach the polling loop.
      await sent
      await jest.runAllTimersAsync()
      await assertion
      expect(rpc.getTransaction).toHaveBeenCalledTimes(30)
    })
  })

  // ── invokeAsFeePayer ────────────────────────────────────────────────────────

  describe('invokeAsFeePayer', () => {
    it('simulates once, signs with the fee payer keypair, and returns the hash on success', async () => {
      const rpc = createMockRpc({
        simulateTransaction: jest.fn().mockResolvedValue(
          buildSimSuccess({
            minResourceFee: '500',
            transactionDataXdr: buildTransactionDataXdr({ resourceFee: '500', instructions: 25_000 }),
          }),
        ),
      })

      const hash = await invokeAsFeePayer({
        contractId: TARGET_CONTRACT_ID,
        method: 'transfer',
        args: [nativeToScVal(50n, { type: 'i128' })],
        feePayerKeypair: FEE_PAYER_KP,
        rpcUrl: RPC_URL,
        networkPassphrase: TESTNET,
      })

      expect(hash).toBe(FAKE_TX_HASH)
      expect(rpc.simulateTransaction).toHaveBeenCalledTimes(1)
      expect(rpc.sendTransaction).toHaveBeenCalledTimes(1)

      const submittedTx = rpc.sendTransaction.mock.calls[0][0] as Transaction
      expect(submittedTx.signatures).toHaveLength(1)
      expect(
        FEE_PAYER_KP.verify(submittedTx.hash(), submittedTx.signatures[0].signature()),
      ).toBe(true)
    })

    it('throws on simulation error without calling sendTransaction', async () => {
      const rpc = createMockRpc({
        simulateTransaction: jest.fn().mockResolvedValue(buildSimError('insufficient balance')),
      })

      await expect(
        invokeAsFeePayer({
          contractId: TARGET_CONTRACT_ID,
          method: 'transfer',
          args: [],
          feePayerKeypair: FEE_PAYER_KP,
          rpcUrl: RPC_URL,
          networkPassphrase: TESTNET,
        }),
      ).rejects.toThrow('Simulation failed: insufficient balance')

      expect(rpc.sendTransaction).not.toHaveBeenCalled()
    })

    it('throws when sendTransaction returns status ERROR', async () => {
      const errResult = buildErrorTransactionResult()
      createMockRpc({
        simulateTransaction: jest.fn().mockResolvedValue(buildSimSuccess()),
        sendTransaction: jest.fn().mockResolvedValue({
          status: 'ERROR',
          errorResult: errResult,
          latestLedger: 5000,
          latestLedgerCloseTime: '0',
        }),
      })

      await expect(
        invokeAsFeePayer({
          contractId: TARGET_CONTRACT_ID,
          method: 'transfer',
          args: [],
          feePayerKeypair: FEE_PAYER_KP,
          rpcUrl: RPC_URL,
          networkPassphrase: TESTNET,
        }),
      ).rejects.toThrow(`Transaction rejected: ${errResult.toXDR('base64')}`)
    })

    it('throws when polled transaction status is FAILED', async () => {
      createMockRpc({
        simulateTransaction: jest.fn().mockResolvedValue(buildSimSuccess()),
        getTransaction: jest.fn().mockResolvedValue({
          status: SorobanRpc.Api.GetTransactionStatus.FAILED,
          resultMetaXdr: buildDiagnosticContractErrorMeta(10),
        }),
      })

      await expect(
        invokeAsFeePayer({
          contractId: TARGET_CONTRACT_ID,
          method: 'transfer',
          args: [],
          feePayerKeypair: FEE_PAYER_KP,
          rpcUrl: RPC_URL,
          networkPassphrase: TESTNET,
        }),
      ).rejects.toThrow('Transaction failed: FAILED | sceContract=10')
    })

    it('throws the timeout error when getTransaction never leaves NOT_FOUND (using fake timers)', async () => {
      jest.useFakeTimers()

      const rpc = createMockRpc({
        simulateTransaction: jest.fn().mockResolvedValue(buildSimSuccess()),
        getTransaction: jest.fn().mockResolvedValue({
          status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND,
          latestLedger: 5000,
        }),
      })

      const promise = invokeAsFeePayer({
        contractId: TARGET_CONTRACT_ID,
        method: 'transfer',
        args: [],
        feePayerKeypair: FEE_PAYER_KP,
        rpcUrl: RPC_URL,
        networkPassphrase: TESTNET,
      })

      const assertion = expect(promise).rejects.toThrow(
        'Transaction timed out — check status manually',
      )

      await jest.runAllTimersAsync()
      await assertion
      expect(rpc.getTransaction).toHaveBeenCalledTimes(30)
    })
  })

  // ── describeFailure ─────────────────────────────────────────────────────────

  describe('describeFailure', () => {
    it('returns "status | sceContract=N" when a v3 diagnostic event carries a contract error', () => {
      const meta = buildDiagnosticContractErrorMeta(16, 3)

      const reason = describeFailure(
        { status: 'FAILED', resultMetaXdr: meta },
        'test-flow',
      )

      expect(reason).toBe('FAILED | sceContract=16')
    })

    it('falls back to the status when resultMetaXdr cannot be read', () => {
      const unreadableMeta = {
        switch: () => {
          throw new Error('corrupt XDR')
        },
        toXDR: () => {
          throw new Error('corrupt XDR')
        },
      }

      const reason = describeFailure(
        { status: 'FAILED', resultMetaXdr: unreadableMeta },
        'test-flow',
      )

      expect(reason).toBe('FAILED')
    })

    it('falls back to the status when resultMetaXdr is missing and no resultXdr is present', () => {
      expect(describeFailure({ status: 'FAILED' })).toBe('FAILED')
    })
  })
})
