/**
 * Unit tests for lib/guardian.ts (#1174).
 *
 * All Soroban RPC interactions and the passkey prompt are mocked — no real
 * network calls. The contract-side behaviour (who may call set_guardian /
 * initiate_recovery / complete_recovery / cancel_recovery, and when) is pinned
 * by contracts/invisible_wallet/src/guardian_test.rs and
 * operator_refusal_tests.rs; these tests pin the CLIENT side: the calls built,
 * the signatures attached, the error words a user sees, and the honest copy.
 */

if (typeof TextEncoder === 'undefined') {
  const { TextEncoder: TE, TextDecoder: TD } = require('util')
  global.TextEncoder = TE
  global.TextDecoder = TD
}

const { webcrypto } = require('crypto')
Object.defineProperty(global, 'crypto', {
  value: webcrypto,
  writable: true,
  configurable: true,
})

import {
  GUARDIAN_CAN,
  GUARDIAN_CANNOT,
  GUARDIAN_DELAY_SECONDS,
  RECOVERY_SERVER_DELAY_SECONDS,
  cancelPendingRecovery,
  completeRecoveryPermissionless,
  initiateRecoveryAsGuardian,
  isGuardianRecoveryUnlocked,
  readGuardian,
  readPendingRecovery,
} from '../guardian'
import { Account, Keypair, Networks } from '@stellar/stellar-sdk'

// ── Module mock ───────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
jest.mock('@stellar/stellar-sdk', (): any => {
  const actual = jest.requireActual('@stellar/stellar-sdk')
  return {
    ...actual,
    scValToNative: jest.fn().mockImplementation((val: any) => {
      if (val && val._native !== undefined) return val._native
      return 0n
    }),
    rpc: {
      ...actual.rpc,
      Server: jest.fn(),
      assembleTransaction: jest.fn(),
      Api: {
        ...actual.rpc.Api,
        isSimulationError: jest.fn().mockImplementation((sim: any) => !!(sim && sim.error)),
      },
    },
  }
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sdk = jest.requireMock('@stellar/stellar-sdk') as Record<string, any>
const MockServer: jest.Mock = sdk.rpc.Server
const mockAssembleTransaction: jest.Mock = sdk.rpc.assembleTransaction

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WALLET_ADDRESS = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4'
const GUARDIAN_KP = Keypair.random()
const RPC_URL = 'https://soroban-testnet.stellar.org'
const PASSPHRASE = Networks.TESTNET

const NEW_KEY = (() => {
  const k = new Uint8Array(65)
  k[0] = 0x04
  for (let i = 1; i < 65; i++) k[i] = i
  return k
})()

const FAKE_WEBAUTHN_SIG = {
  publicKey: new Uint8Array(65),
  authData: new Uint8Array(37),
  clientDataJSON: new Uint8Array(100),
  signature: new Uint8Array(64),
}

/** The function name invoked by a built transaction's first operation. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invokedFunction(tx: any): string | undefined {
  try {
    return tx.operations[0].func?.invokeContract?.()?.functionName?.()?.toString()
  } catch {
    return undefined
  }
}

/** A mock auth entry shaped the way cancelPendingRecovery reads one. */
function makeMockAuthEntry() {
  const contractFn = new sdk.xdr.InvokeContractArgs({
    contractAddress: sdk.Address.fromString(WALLET_ADDRESS).toScAddress(),
    functionName: 'cancel_recovery',
    args: [],
  })
  const invocation = new sdk.xdr.SorobanAuthorizedInvocation({
    function: sdk.xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(contractFn),
    subInvocations: [],
  })
  const setCredentials = jest.fn()
  const entry = {
    rootInvocation: jest.fn().mockReturnValue(invocation),
    credentials: jest.fn().mockImplementation((newCred?: unknown) => {
      if (newCred === undefined) {
        return {
          switch: () => ({ value: 1 }), // SOROBAN_CREDENTIALS_ADDRESS
          address: () => ({
            address: () => sdk.Address.fromString(WALLET_ADDRESS).toScAddress(),
            nonce: () => sdk.xdr.Int64.fromString('0'),
            signatureExpirationLedger: () => 0,
          }),
        }
      }
      setCredentials(newCred)
    }),
  }
  return { entry, setCredentials }
}

const mockAssembled = { sign: jest.fn() }

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('guardian recovery client (#1174)', () => {
  let mockServer: {
    simulateTransaction: jest.Mock
    sendTransaction: jest.Mock
    getTransaction: jest.Mock
    getAccount: jest.Mock
    getLatestLedger: jest.Mock
    getContractData: jest.Mock
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockServer = {
      simulateTransaction: jest.fn(),
      sendTransaction: jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'abc123' }),
      getTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 500 }),
      getAccount: jest.fn().mockResolvedValue(new Account(GUARDIAN_KP.publicKey(), '7')),
      getContractData: jest.fn(),
    }
    MockServer.mockImplementation(() => mockServer)
    mockAssembleTransaction.mockReturnValue({ build: jest.fn().mockReturnValue(mockAssembled) })
    mockAssembled.sign.mockClear()
  })

  // ── The honest copy ────────────────────────────────────────────────────────

  it('states what a guardian can and cannot do, and both delays, without drift', () => {
    const can = GUARDIAN_CAN.join(' ')
    const cannot = GUARDIAN_CANNOT.join(' ')
    // The power is real and stated: replacement of the wallet's keys.
    expect(can).toContain("replacing your wallet's keys")
    expect(can).toContain('without asking you')
    // The limits are real and stated: no funds access, no skipping the delay,
    // no invisibility, no surviving a cancel.
    expect(cannot).toContain('Move money')
    expect(cannot).toContain('Skip or shorten')
    expect(cannot).toContain('cancel')
    // 3 days on the guardian path, 7 on the recovery-server path — the two
    // mechanisms the contract actually has (lib.rs RECOVERY_DELAY_SECONDS,
    // recovery.rs RECOVERY_KEY_DELAY).
    expect(GUARDIAN_DELAY_SECONDS).toBe(259_200)
    expect(RECOVERY_SERVER_DELAY_SECONDS).toBe(604_800)
  })

  // ── Reads ──────────────────────────────────────────────────────────────────

  it('readGuardian returns the stored address and null when none is set', async () => {
    mockServer.getContractData.mockResolvedValueOnce({
      val: { contractData: () => ({ val: () => ({ _native: GUARDIAN_KP.publicKey() }) }) },
    })
    expect(await readGuardian(WALLET_ADDRESS, RPC_URL)).toBe(GUARDIAN_KP.publicKey())

    mockServer.getContractData.mockRejectedValueOnce(new Error('not found'))
    expect(await readGuardian(WALLET_ADDRESS, RPC_URL)).toBeNull()
  })

  it('readPendingRecovery reports source, key and unlock time from get_pending_recovery', async () => {
    mockServer.simulateTransaction.mockResolvedValueOnce({
      result: {
        retval: {
          _native: {
            source: ['Guardian'],
            new_public_key: NEW_KEY,
            recovery_unlock_time: 1_900_000_000n,
          },
        },
        auth: [],
      },
    })
    const pending = await readPendingRecovery(WALLET_ADDRESS, RPC_URL, PASSPHRASE)
    expect(pending).toEqual({
      source: 'guardian',
      newPublicKeyHex: Buffer.from(NEW_KEY).toString('hex'),
      unlockTime: 1_900_000_000,
    })
    expect(invokedFunction(mockServer.simulateTransaction.mock.calls[0][0])).toBe(
      'get_pending_recovery',
    )

    // The OTHER mechanism is reported as itself, never silently relabelled.
    mockServer.simulateTransaction.mockResolvedValueOnce({
      result: {
        retval: {
          _native: {
            source: 'RecoveryKey',
            new_public_key: NEW_KEY,
            recovery_unlock_time: 42n,
          },
        },
        auth: [],
      },
    })
    const fromServers = await readPendingRecovery(WALLET_ADDRESS, RPC_URL, PASSPHRASE)
    expect(fromServers?.source).toBe('recovery-key')

    // No pending recovery → null, not a throw.
    mockServer.simulateTransaction.mockResolvedValueOnce({ result: { retval: { _native: null }, auth: [] } })
    expect(await readPendingRecovery(WALLET_ADDRESS, RPC_URL, PASSPHRASE)).toBeNull()
  })

  it('isGuardianRecoveryUnlocked respects the unlock time', () => {
    const pending = { source: 'guardian' as const, newPublicKeyHex: '', unlockTime: 1000 }
    expect(isGuardianRecoveryUnlocked(pending, 999)).toBe(false)
    expect(isGuardianRecoveryUnlocked(pending, 1000)).toBe(true)
    expect(isGuardianRecoveryUnlocked(pending, 1001)).toBe(true)
  })

  // ── Initiate (as the guardian) ─────────────────────────────────────────────

  it('initiate builds initiate_recovery for the target wallet and signs as the guardian', async () => {
    mockServer.simulateTransaction.mockResolvedValueOnce({ result: { retval: {}, auth: [] } })

    const { txHash } = await initiateRecoveryAsGuardian({
      walletAddress: WALLET_ADDRESS,
      guardian: GUARDIAN_KP,
      newPublicKey: NEW_KEY,
      rpcUrl: RPC_URL,
      networkPassphrase: PASSPHRASE,
    })

    expect(txHash).toBe('abc123')
    expect(mockServer.getAccount).toHaveBeenCalledWith(GUARDIAN_KP.publicKey())
    expect(invokedFunction(mockServer.simulateTransaction.mock.calls[0][0])).toBe('initiate_recovery')
    expect(mockAssembled.sign).toHaveBeenCalledWith(GUARDIAN_KP)
  })

  it('initiate refuses a malformed key before touching the network', async () => {
    await expect(
      initiateRecoveryAsGuardian({
        walletAddress: WALLET_ADDRESS,
        guardian: GUARDIAN_KP,
        newPublicKey: new Uint8Array(64),
        rpcUrl: RPC_URL,
        networkPassphrase: PASSPHRASE,
      }),
    ).rejects.toThrow('65-byte uncompressed P-256')
    expect(mockServer.simulateTransaction).not.toHaveBeenCalled()
  })

  it('initiate names the no-guardian failure in plain words', async () => {
    mockServer.simulateTransaction.mockResolvedValueOnce({ error: 'HostError: Error(Contract, #12)' })
    await expect(
      initiateRecoveryAsGuardian({
        walletAddress: WALLET_ADDRESS,
        guardian: GUARDIAN_KP,
        newPublicKey: NEW_KEY,
        rpcUrl: RPC_URL,
        networkPassphrase: PASSPHRASE,
      }),
    ).rejects.toThrow('no guardian set')
  })

  // ── Complete (permissionless) ──────────────────────────────────────────────

  it('complete builds complete_recovery and reports a still-active timelock honestly', async () => {
    mockServer.simulateTransaction.mockResolvedValueOnce({ result: { retval: {}, auth: [] } })
    const { txHash } = await completeRecoveryPermissionless({
      walletAddress: WALLET_ADDRESS,
      payer: GUARDIAN_KP,
      rpcUrl: RPC_URL,
      networkPassphrase: PASSPHRASE,
    })
    expect(txHash).toBe('abc123')
    expect(invokedFunction(mockServer.simulateTransaction.mock.calls[0][0])).toBe('complete_recovery')

    mockServer.simulateTransaction.mockResolvedValueOnce({ error: 'Error(Contract, #15) RecoveryTimelockActive' })
    await expect(
      completeRecoveryPermissionless({
        walletAddress: WALLET_ADDRESS,
        payer: GUARDIAN_KP,
        rpcUrl: RPC_URL,
        networkPassphrase: PASSPHRASE,
      }),
    ).rejects.toThrow('waiting period has not elapsed')
  })

  // ── Cancel (owner, passkey-authorised) ─────────────────────────────────────

  function queueCancelSimulations(entry: unknown) {
    // 1: get_nonce probe (nonce-aware wallet), 2: recording-mode sim with the
    // auth entry, 3: enforce-mode re-simulation after signing.
    mockServer.simulateTransaction
      .mockResolvedValueOnce({ result: { retval: { _native: 5n }, auth: [] } })
      .mockResolvedValueOnce({ result: { retval: {}, auth: [entry] } })
      .mockResolvedValueOnce({ result: { retval: {}, auth: [] } })
  }

  it('cancel signs the auth entry with the passkey and submits', async () => {
    const { entry, setCredentials } = makeMockAuthEntry()
    queueCancelSimulations(entry)
    const signAuthEntry = jest.fn().mockResolvedValue(FAKE_WEBAUTHN_SIG)

    const { txHash } = await cancelPendingRecovery({
      walletAddress: WALLET_ADDRESS,
      feePayer: GUARDIAN_KP,
      signAuthEntry,
      rpcUrl: RPC_URL,
      networkPassphrase: PASSPHRASE,
    })

    expect(txHash).toBe('abc123')
    // The passkey signed a 32-byte payload hash…
    expect(signAuthEntry).toHaveBeenCalledTimes(1)
    expect((signAuthEntry.mock.calls[0][0] as Uint8Array).length).toBe(32)
    // …its signature was attached to the entry…
    expect(setCredentials).toHaveBeenCalledTimes(1)
    // …the recording sim targeted cancel_recovery, and an enforce-mode
    // re-simulation ran before assembly (3 sims incl. the nonce probe).
    expect(invokedFunction(mockServer.simulateTransaction.mock.calls[1][0])).toBe('cancel_recovery')
    expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(3)
    expect(mockAssembled.sign).toHaveBeenCalledWith(GUARDIAN_KP)
  })

  it('cancel stops cleanly when the passkey prompt is dismissed', async () => {
    const { entry } = makeMockAuthEntry()
    queueCancelSimulations(entry)
    const signAuthEntry = jest.fn().mockResolvedValue(null)

    await expect(
      cancelPendingRecovery({
        walletAddress: WALLET_ADDRESS,
        feePayer: GUARDIAN_KP,
        signAuthEntry,
        rpcUrl: RPC_URL,
        networkPassphrase: PASSPHRASE,
      }),
    ).rejects.toThrow('cancelled')
    expect(mockServer.sendTransaction).not.toHaveBeenCalled()
  })

  it('cancel reports nothing-pending in plain words', async () => {
    mockServer.simulateTransaction
      .mockResolvedValueOnce({ result: { retval: { _native: 5n }, auth: [] } })
      .mockResolvedValueOnce({ error: 'Error(Contract, #14) RecoveryNotPending' })

    await expect(
      cancelPendingRecovery({
        walletAddress: WALLET_ADDRESS,
        feePayer: GUARDIAN_KP,
        signAuthEntry: jest.fn(),
        rpcUrl: RPC_URL,
        networkPassphrase: PASSPHRASE,
      }),
    ).rejects.toThrow('No recovery is pending')
  })
})
