import { Keypair } from '@stellar/stellar-sdk'

// ── Module-level mocks ───────────────────────────────────────────────────────
// The @veil/sdk barrel re-exports the whole SDK core, which reads
// `Horizon.Server` at module scope. With the SDK mocked below that blows up.
// Stub the one export the dependency chain needs (lib/fees → @veil/sdk).
jest.mock('@veil/sdk', () => ({ inclusionFee: () => '100' }))

// describeFailure is the helper we want sorobanTx to call. We mock it so we
// can verify integration without pulling in the entire walletInvoke module.
const mockDescribeFailure = jest.fn(
  (result: any, _label?: string) =>
    `FAILED | sceContract=42`,
)
jest.mock('../walletInvoke', () => ({
  describeFailure: (result: any, label?: string) => mockDescribeFailure(result, label),
}))

// fee-bump helper: return a distinguishable object so we can assert the
// sponsor path sends this instead of the plain transaction.
const mockBuildFeeBump = jest.fn(
  (_params: any) => ({ __feeBump: true } as any),
)
jest.mock('../feeBump', () => ({
  buildSponsoredFeeBumpTransaction: (p: any) => mockBuildFeeBump(p),
}))

// ── Fake RPC plumbing ────────────────────────────────────────────────────────
const mockSimulate = jest.fn()
const mockSendTransaction = jest.fn()
const mockGetTransaction = jest.fn()

jest.mock('@stellar/stellar-sdk', () => {
  // Generate real-ish Keypairs that behave like the actual SDK's: they have
  // publicKey(), secret(), and can be constructed from random().
  const fakeKeypair = (pub: string, sec: string) => ({
    publicKey: jest.fn(() => pub),
    secret: jest.fn(() => sec),
  })
  let counter = 0
  const KeypairMock = {
    fromSecret: jest.fn((s: string) => fakeKeypair(`G_PUB_${s}`, s)),
    random: jest.fn(() => {
      counter++
      return fakeKeypair(`GRAND${counter}`, `SRAND${counter}`)
    }),
  }

  // A minimal Transaction stand-in that records `sign` calls.
  const fakeAssembled = {
    sign: jest.fn(),
    __assembled: true,
  }

  // TransactionBuilder mock
  const fromXDR = jest.fn(() => ({ __built: true }))
  const TransactionBuilderMock = { fromXDR }

  // SorobanRpc mock
  const ServerMock = jest.fn().mockImplementation(() => ({
    simulateTransaction: mockSimulate,
    sendTransaction: mockSendTransaction,
    getTransaction: mockGetTransaction,
  }))

  const assembleTransaction = jest.fn(() => ({ build: () => fakeAssembled }))

  const isSimulationError = jest.fn(
    (sim: any) => !!(sim && sim.error),
  )

  const rpc = {
    Server: ServerMock,
    Api: {
      isSimulationError,
      GetTransactionStatus: {
        NOT_FOUND: 'NOT_FOUND',
        SUCCESS: 'SUCCESS',
        FAILED: 'FAILED',
      },
    },
    assembleTransaction,
  }

  return {
    __esModule: true,
    Keypair: KeypairMock,
    TransactionBuilder: TransactionBuilderMock,
    rpc,
    // Module-scope symbols needed by transitive imports (lib/fees → lib/network)
    Networks: {
      TESTNET: 'Test SDF Network ; September 2015',
      PUBLIC: 'Public Global Stellar Network ; September 2015',
    },
    Asset: { native: () => ({ contractId: () => 'CNATIVE' }) },
    xdr: {},
  }
})

// ── Import the module under test *after* mocks are in place ──────────────────
import { signAndSubmitSorobanXdr } from '../sorobanTx'
import { rpc as SorobanRpc } from '@stellar/stellar-sdk'

// ── Helpers ──────────────────────────────────────────────────────────────────
const PASSPHRASE = 'Test SDF Network ; September 2015'
const TEST_XDR = 'AAAA_FAKE_XDR'
const TEST_HASH = 'abc123def456'

function baseParams(overrides: Record<string, unknown> = {}) {
  const kp = Keypair.random()
  return {
    xdr: TEST_XDR,
    signerSecret: kp.secret(),
    rpcUrl: 'https://rpc.example.com',
    networkPassphrase: PASSPHRASE,
    ...overrides,
  }
}

/** Configure mocks for a "happy path" simulation + send + confirm. */
function happyPath() {
  mockSimulate.mockResolvedValue({ /* no .error → not a sim error */ })
  mockSendTransaction.mockResolvedValue({
    status: 'PENDING',
    hash: TEST_HASH,
  })
  mockGetTransaction.mockResolvedValue({
    status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
  })
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe('signAndSubmitSorobanXdr', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // (a) simulation error throws "Simulation failed: …" and nothing is sent
  it('throws on simulation error without sending', async () => {
    mockSimulate.mockResolvedValue({ error: 'host invocation failed' })

    await expect(signAndSubmitSorobanXdr(baseParams())).rejects.toThrow(
      'Simulation failed: host invocation failed',
    )
    expect(mockSendTransaction).not.toHaveBeenCalled()
  })

  // (b) the transaction is signed by the signer key before it is sent
  it('signs the assembled transaction with the signer keypair before sending', async () => {
    happyPath()
    const params = baseParams()
    await signAndSubmitSorobanXdr(params)

    // assembleTransaction returns a builder whose .build() gives fakeAssembled
    const { assembleTransaction } = jest.requireMock('@stellar/stellar-sdk').rpc
    expect(assembleTransaction).toHaveBeenCalled()

    // The fakeAssembled's .sign must have been called with a keypair derived
    // from signerSecret — before sendTransaction.
    const assembled = assembleTransaction.mock.results[0].value.build()
    expect(assembled.sign).toHaveBeenCalled()
    const signerArg = assembled.sign.mock.calls[0][0]
    // The keypair should be the one derived from the params.signerSecret
    expect(Keypair.fromSecret).toHaveBeenCalledWith(params.signerSecret)
    expect(signerArg.publicKey()).toBe(`G_PUB_${params.signerSecret}`)
  })

  // (c) with sponsorSecret, a fee-bump transaction is sent;
  //     without it, the plain transaction is sent
  it('sends a fee-bump transaction when sponsorSecret is provided', async () => {
    happyPath()
    const sponsorKp = Keypair.random()
    const sponsorSec = sponsorKp.secret()
    const params = baseParams({ sponsorSecret: sponsorSec })
    await signAndSubmitSorobanXdr(params)

    expect(mockBuildFeeBump).toHaveBeenCalledWith(
      expect.objectContaining({
        networkPassphrase: PASSPHRASE,
        sponsor: { secret: sponsorSec },
      }),
    )
    // sendTransaction receives the fee-bump wrapper, not the plain assembled tx
    const sentTx = mockSendTransaction.mock.calls[0][0]
    expect(sentTx).toHaveProperty('__feeBump', true)
  })

  it('sends the plain assembled transaction when no sponsorSecret', async () => {
    happyPath()
    await signAndSubmitSorobanXdr(baseParams())

    expect(mockBuildFeeBump).not.toHaveBeenCalled()
    const sentTx = mockSendTransaction.mock.calls[0][0]
    expect(sentTx).toHaveProperty('__assembled', true)
  })

  // (d) sendTransaction status ERROR throws
  it('throws when sendTransaction returns ERROR status', async () => {
    mockSimulate.mockResolvedValue({})
    mockSendTransaction.mockResolvedValue({
      status: 'ERROR',
      errorResult: { toXDR: (_: string) => 'DEADBEEF' },
    })

    await expect(signAndSubmitSorobanXdr(baseParams())).rejects.toThrow(
      'Transaction rejected: DEADBEEF',
    )
  })

  it('throws "unknown" when sendTransaction ERROR has no errorResult', async () => {
    mockSimulate.mockResolvedValue({})
    mockSendTransaction.mockResolvedValue({
      status: 'ERROR',
      errorResult: undefined,
    })

    await expect(signAndSubmitSorobanXdr(baseParams())).rejects.toThrow(
      'Transaction rejected: unknown',
    )
  })

  // (e) a failed result throws a message that includes the reason from describeFailure
  it('includes the reason from describeFailure when the transaction fails on-chain', async () => {
    mockSimulate.mockResolvedValue({})
    mockSendTransaction.mockResolvedValue({
      status: 'PENDING',
      hash: TEST_HASH,
    })
    mockGetTransaction.mockResolvedValue({
      status: SorobanRpc.Api.GetTransactionStatus.FAILED,
      resultMetaXdr: 'some-meta',
    })

    await expect(signAndSubmitSorobanXdr(baseParams())).rejects.toThrow(
      'Transaction failed: FAILED | sceContract=42',
    )
    expect(mockDescribeFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        status: SorobanRpc.Api.GetTransactionStatus.FAILED,
      }),
      'swap',
    )
  })

  // (f) a result that never leaves NOT_FOUND throws the timeout error (fake timers)
  it('throws timeout when result stays NOT_FOUND', async () => {
    jest.useFakeTimers()

    mockSimulate.mockResolvedValue({})
    mockSendTransaction.mockResolvedValue({
      status: 'PENDING',
      hash: TEST_HASH,
    })
    mockGetTransaction.mockResolvedValue({
      status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND,
    })

    // Capture the rejection immediately so Node doesn't treat it as unhandled.
    let caughtError: Error | undefined
    const promise = signAndSubmitSorobanXdr(baseParams()).catch((e) => {
      caughtError = e
    })

    // Each loop iteration awaits getTransaction (resolved → microtask) then
    // awaits a 1 s setTimeout. advanceTimersByTimeAsync flushes both.
    for (let i = 0; i < 30; i++) {
      await jest.advanceTimersByTimeAsync(1_000)
    }

    await promise

    expect(caughtError).toBeDefined()
    expect(caughtError!.message).toBe('Transaction timed out - check status manually')

    jest.useRealTimers()
  })

  // (g) success returns the hash
  it('returns the transaction hash on success', async () => {
    happyPath()
    const hash = await signAndSubmitSorobanXdr(baseParams())
    expect(hash).toBe(TEST_HASH)
  })
})
