/**
 * Unit tests for sweepContractBalance.
 *
 * All Soroban RPC interactions and WebAuthn calls are mocked — no real network
 * calls are made.
 */

import { sweepContractBalance } from '../sweepContractBalance'
import { Keypair, Account, Networks } from '@stellar/stellar-sdk'

// ── Module mock ───────────────────────────────────────────────────────────────
// `: any` return type bypasses TypeScript's strict module-shape checking inside
// the factory — standard pattern for jest.mock with typed SDK modules.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
jest.mock('@stellar/stellar-sdk', (): any => {
  const actual = jest.requireActual('@stellar/stellar-sdk')
  return {
    ...actual,
    scValToNative: jest.fn(),
    xdr: {
      ...actual.xdr,
      SorobanAddressCredentials: jest.fn().mockImplementation(() => ({})),
      SorobanCredentials: {
        ...actual.xdr.SorobanCredentials,
        sorobanCredentialsAddress: jest.fn().mockReturnValue({}),
      },
    },
    rpc: {
      ...actual.rpc,
      Server: jest.fn(),
      assembleTransaction: jest.fn(),
      Api: {
        ...actual.rpc.Api,
        isSimulationError: jest.fn(),
      },
    },
  }
})

// ── Typed access to mock fns ──────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sdk = jest.requireMock('@stellar/stellar-sdk') as Record<string, any>
const mockScValToNative:     jest.Mock = sdk.scValToNative
const MockServer:            jest.Mock = sdk.rpc.Server
const mockAssembleTransaction: jest.Mock = sdk.rpc.assembleTransaction
const mockIsSimulationError: jest.Mock = sdk.rpc.Api.isSimulationError

// ── Response builders ─────────────────────────────────────────────────────────

function makeBalanceSim(balance: bigint) {
  mockScValToNative.mockReturnValueOnce(balance)
  return { latestLedger: 100, result: { retval: {}, auth: [] } }
}

function makeTransferSim(auth: unknown[] = []) {
  return { latestLedger: 100, result: { retval: {}, auth } }
}

function makeSimError(message = 'contract error') {
  return { error: message, latestLedger: 100 }
}

// Mock auth entry with the structure sweepContractBalance reads
function makeMockAuthEntry() {
  const entry = {
    credentials: jest.fn(),
    rootInvocation: jest.fn().mockReturnValue({
      toXDR: jest.fn().mockReturnValue(new Uint8Array(64)),
    }),
  }
  entry.credentials.mockImplementation((newCred?: unknown) => {
    if (newCred === undefined) {
      return {
        switch:  () => ({ value: 1 }), // SOROBAN_CREDENTIALS_ADDRESS = 1
        address: () => ({
          address:                   () => ({}),
          nonce:                     () => 0n,
          signatureExpirationLedger: () => 0,
        }),
      }
    }
    // setter invocation — intentional no-op
  })
  return entry
}

const mockAssembled = { sign: jest.fn() }

// ── Constants ─────────────────────────────────────────────────────────────────

const CONTRACT_ADDRESS   = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4'
const FEE_PAYER_KP       = Keypair.random()
const RPC_URL            = 'https://soroban-testnet.stellar.org'
const NETWORK_PASSPHRASE = Networks.TESTNET

const FAKE_WEBAUTHN_SIG = {
  publicKey:      new Uint8Array(65),
  authData:       new Uint8Array(37),
  clientDataJSON: new Uint8Array(100),
  signature:      new Uint8Array(64),
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('sweepContractBalance', () => {
  let mockServer: {
    simulateTransaction: jest.Mock
    sendTransaction:     jest.Mock
    getTransaction:      jest.Mock
    getAccount:          jest.Mock
  }
  let mockSignAuthEntry: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()

    mockServer = {
      simulateTransaction: jest.fn(),
      sendTransaction:     jest.fn(),
      getTransaction:      jest.fn(),
      getAccount:          jest.fn().mockResolvedValue(
        new Account(FEE_PAYER_KP.publicKey(), '100')
      ),
    }
    MockServer.mockImplementation(() => mockServer)

    mockAssembleTransaction.mockReturnValue({
      build: jest.fn().mockReturnValue(mockAssembled),
    })
    mockAssembled.sign.mockClear()

    mockIsSimulationError.mockReturnValue(false)

    mockSignAuthEntry = jest.fn().mockResolvedValue(FAKE_WEBAUTHN_SIG)
  })

  // ── 1. Balance = 0 ───────────────────────────────────────────────────────

  it('does not build or submit a transfer when contract balance is zero', async () => {
    mockServer.simulateTransaction.mockResolvedValueOnce(makeBalanceSim(0n))

    await expect(
      sweepContractBalance(CONTRACT_ADDRESS, FEE_PAYER_KP, mockSignAuthEntry, RPC_URL, NETWORK_PASSPHRASE)
    ).rejects.toThrow('Contract balance is zero')

    expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(1)
    expect(mockServer.sendTransaction).not.toHaveBeenCalled()
  })

  // ── 2. Correct call + submission ─────────────────────────────────────────

  it('builds the correct SAC.transfer call and submits the transaction', async () => {
    mockServer.simulateTransaction
      .mockResolvedValueOnce(makeBalanceSim(5_000_000n))
      .mockResolvedValueOnce(makeTransferSim())

    mockServer.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'txhash-abc' })
    mockServer.getTransaction.mockResolvedValue({ status: 'SUCCESS' })

    const hash = await sweepContractBalance(
      CONTRACT_ADDRESS, FEE_PAYER_KP, mockSignAuthEntry, RPC_URL, NETWORK_PASSPHRASE
    )

    expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(2)
    expect(mockServer.sendTransaction).toHaveBeenCalledTimes(1)
    expect(hash).toBe('txhash-abc')
    expect(mockAssembled.sign).toHaveBeenCalledWith(FEE_PAYER_KP)
  })

  // ── 3. signAuthEntry called with 32-byte hash ────────────────────────────

  it('calls signAuthEntry with a 32-byte SHA-256 payload when an auth entry is present', async () => {
    const authEntry = makeMockAuthEntry()

    mockServer.simulateTransaction
      .mockResolvedValueOnce(makeBalanceSim(10_000_000n))
      .mockResolvedValueOnce(makeTransferSim([authEntry]))

    mockServer.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'tx-signed' })
    mockServer.getTransaction.mockResolvedValue({ status: 'SUCCESS' })

    await sweepContractBalance(
      CONTRACT_ADDRESS, FEE_PAYER_KP, mockSignAuthEntry, RPC_URL, NETWORK_PASSPHRASE
    )

    expect(mockSignAuthEntry).toHaveBeenCalledTimes(1)

    const [payload] = mockSignAuthEntry.mock.calls[0] as [Uint8Array]
    expect(payload).toBeInstanceOf(Uint8Array)
    expect(payload.byteLength).toBe(32) // SHA-256 is always 32 bytes
  })

  // ── 4. Poll until SUCCESS ─────────────────────────────────────────────────

  it('polls getTransaction until SUCCESS and resolves with the hash', async () => {
    jest.useFakeTimers()

    mockServer.simulateTransaction
      .mockResolvedValueOnce(makeBalanceSim(1_000_000n))
      .mockResolvedValueOnce(makeTransferSim())

    mockServer.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'polled-hash' })
    mockServer.getTransaction
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'SUCCESS' })

    const promise = sweepContractBalance(
      CONTRACT_ADDRESS, FEE_PAYER_KP, mockSignAuthEntry, RPC_URL, NETWORK_PASSPHRASE
    )

    await jest.advanceTimersByTimeAsync(3_000)

    const hash = await promise
    expect(hash).toBe('polled-hash')
    expect(mockServer.getTransaction).toHaveBeenCalledTimes(3)

    jest.useRealTimers()
  })

  // ── 5. Simulation error ───────────────────────────────────────────────────

  it('throws when the transfer simulation returns an error', async () => {
    mockServer.simulateTransaction.mockResolvedValueOnce(makeBalanceSim(2_000_000n))

    mockIsSimulationError
      .mockReturnValueOnce(false) // balance check passes
      .mockReturnValueOnce(true)  // transfer sim fails
    mockServer.simulateTransaction.mockResolvedValueOnce(makeSimError('insufficient reserves'))

    await expect(
      sweepContractBalance(CONTRACT_ADDRESS, FEE_PAYER_KP, mockSignAuthEntry, RPC_URL, NETWORK_PASSPHRASE)
    ).rejects.toThrow('Simulation failed')

    expect(mockServer.sendTransaction).not.toHaveBeenCalled()
  })

  // ── 6. User cancels passkey ───────────────────────────────────────────────

  it('throws when the user cancels the passkey prompt (signAuthEntry returns null)', async () => {
    const authEntry = makeMockAuthEntry()

    mockServer.simulateTransaction
      .mockResolvedValueOnce(makeBalanceSim(3_000_000n))
      .mockResolvedValueOnce(makeTransferSim([authEntry]))

    mockSignAuthEntry.mockResolvedValue(null)

    await expect(
      sweepContractBalance(CONTRACT_ADDRESS, FEE_PAYER_KP, mockSignAuthEntry, RPC_URL, NETWORK_PASSPHRASE)
    ).rejects.toThrow('WebAuthn signing was cancelled')

    expect(mockServer.sendTransaction).not.toHaveBeenCalled()
  })

  // ── 7. Poll timeout ───────────────────────────────────────────────────────

  it('throws after the maximum number of poll attempts when the transaction stays NOT_FOUND', async () => {
    jest.useFakeTimers()

    mockServer.simulateTransaction
      .mockResolvedValueOnce(makeBalanceSim(7_000_000n))
      .mockResolvedValueOnce(makeTransferSim())

    mockServer.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'slow-hash' })
    mockServer.getTransaction.mockResolvedValue({ status: 'NOT_FOUND' })

    const promise = sweepContractBalance(
      CONTRACT_ADDRESS, FEE_PAYER_KP, mockSignAuthEntry, RPC_URL, NETWORK_PASSPHRASE
    )

    await jest.advanceTimersByTimeAsync(35_000) // past 30 × 1 s poll intervals

    await expect(promise).rejects.toThrow('Transaction timed out')

    jest.useRealTimers()
  })
})
