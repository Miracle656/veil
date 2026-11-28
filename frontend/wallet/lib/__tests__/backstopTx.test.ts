import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true })
Object.assign(globalThis, { TextEncoder, TextDecoder })

/**
 * The backstop write path, proved against real XDR.
 *
 * Only the network boundary is stubbed: `rpc.Server` (account lookup and
 * simulation). Everything that decides what is actually signed runs for real —
 * the Stellar SDK's `Contract` client encodes the invocation,
 * `TransactionBuilder` wraps it, and `assembleTransaction` attaches the
 * simulation's footprint, resource fee and auth entries. Each test then decodes
 * the envelope and checks the contract, method, arguments and auth, so a stub
 * that merely returns a string cannot satisfy it.
 */

const mockGetAccount = jest.fn()
const mockSimulate = jest.fn()

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk')
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: jest.fn().mockImplementation(() => ({
        getAccount: (...args: unknown[]) => mockGetAccount(...args),
        simulateTransaction: (...args: unknown[]) => mockSimulate(...args),
      })),
    },
  }
})

jest.mock('../network', () => ({
  getNetwork: () => ({
    name: 'mainnet',
    displayName: 'Mainnet',
    rpcUrl: 'https://rpc.invalid',
    horizonUrl: 'https://horizon.invalid',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
  }),
}))

jest.mock('../fees', () => ({ inclusionFee: () => '100000' }))

import {
  Address,
  Operation,
  Transaction,
  TransactionBuilder,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'

import {
  buildBackstopCancelWithdrawalXdr,
  buildBackstopDepositXdr,
  buildBackstopQueueWithdrawalXdr,
  buildBackstopWithdrawXdr,
} from '../backstopTx'

const BACKSTOP = 'CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7'
const POOL = 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD'
const USER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const PASSPHRASE = 'Public Global Stellar Network ; September 2015'

function sorobanTransactionData(): xdr.SorobanTransactionData {
  return new xdr.SorobanTransactionData({
    ext: new xdr.SorobanTransactionDataExt(0),
    resources: new xdr.SorobanResources({
      footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
      instructions: 1_000_000,
      diskReadBytes: 0,
      writeBytes: 0,
    }),
    resourceFee: xdr.Int64.fromString('1000'),
  })
}

/** The auth entry the network would hand back for `from.require_auth()`. */
function authEntry(functionName: string): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(BACKSTOP).toScAddress(),
          functionName,
          args: [],
        }),
      ),
      subInvocations: [],
    }),
  })
}

/**
 * A parsed, successful simulation response. `_parsed` is what a real
 * `server.simulateTransaction()` hands back — it stops the SDK re-parsing the
 * object as a raw JSON response.
 */
function simulationSuccess(functionName: string) {
  return {
    _parsed: true,
    latestLedger: 123,
    minResourceFee: '1000',
    transactionData: { build: () => sorobanTransactionData() },
    result: { auth: [authEntry(functionName)], retval: xdr.ScVal.scvVoid() },
    events: [],
  }
}

function decode(xdrString: string) {
  const transaction = TransactionBuilder.fromXDR(xdrString, PASSPHRASE) as Transaction
  expect(transaction.operations).toHaveLength(1)
  const operation = transaction.operations[0]
  expect(operation.type).toBe('invokeHostFunction')
  return { transaction, operation: operation as Operation.InvokeHostFunction }
}

const base = {
  backstopId: BACKSTOP,
  poolId: POOL,
  sourceAddress: USER,
  from: USER,
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetAccount.mockResolvedValue({
    accountId: () => USER,
    sequenceNumber: () => '7',
  })
  mockSimulate.mockImplementation((transaction: Transaction) => {
    const operation = transaction.operations[0] as Operation.InvokeHostFunction
    return Promise.resolve(simulationSuccess(operation.func.invokeContract().functionName().toString()))
  })
})

describe('deposit', () => {
  it('encodes an LP-token deposit to the backstop and attaches the auth entry', async () => {
    const { transaction, operation } = decode(
      await buildBackstopDepositXdr({ ...base, amountStroops: 4_200_000_000n }),
    )
    const invocation = operation.func.invokeContract()

    expect(Address.fromScAddress(invocation.contractAddress()).toString()).toBe(BACKSTOP)
    expect(invocation.functionName().toString()).toBe('deposit')
    expect(invocation.args().map((arg) => scValToNative(arg))).toEqual([
      USER,
      POOL,
      4_200_000_000n,
    ])

    // The auth entry comes from the simulation and is on the signed envelope.
    expect(operation.auth).toHaveLength(1)
    expect(operation.auth?.[0].credentials().switch().name).toBe(
      'sorobanCredentialsSourceAccount',
    )

    // Classic fee plus the simulation's resource fee, and the footprint it
    // produced — the envelope a node accepts for a Soroban invoke.
    expect(transaction.fee).toBe('101000')
    const sorobanData = transaction.toEnvelope().v1().tx().ext().value() as
      | xdr.SorobanTransactionData
      | undefined
    expect(sorobanData).toBeDefined()
    expect(sorobanData?.resources().instructions()).toBe(1_000_000)
    expect(sorobanData?.resourceFee().toString()).toBe('1000')

    // Built against the account the RPC reported, one operation, source = user.
    expect(transaction.source).toBe(USER)
    expect(transaction.sequence).toBe('8')
  })
})

describe('queue, cancel and withdraw', () => {
  it('routes each to its own contract method, in shares', async () => {
    const queue = decode(
      await buildBackstopQueueWithdrawalXdr({ ...base, amountStroops: 1_000_000n }),
    )
    const cancel = decode(
      await buildBackstopCancelWithdrawalXdr({ ...base, amountStroops: 2_000_000n }),
    )
    const withdraw = decode(
      await buildBackstopWithdrawXdr({ ...base, amountStroops: 3_000_000n }),
    )

    expect(queue.operation.func.invokeContract().functionName().toString()).toBe(
      'queue_withdrawal',
    )
    expect(scValToNative(queue.operation.func.invokeContract().args()[2])).toBe(1_000_000n)

    // The contract calls cancellation `dequeue_withdrawal`; the screen calls it
    // cancel because that is what it does to the queue.
    expect(cancel.operation.func.invokeContract().functionName().toString()).toBe(
      'dequeue_withdrawal',
    )
    expect(scValToNative(cancel.operation.func.invokeContract().args()[2])).toBe(2_000_000n)

    expect(withdraw.operation.func.invokeContract().functionName().toString()).toBe('withdraw')
    expect(scValToNative(withdraw.operation.func.invokeContract().args()[2])).toBe(3_000_000n)

    for (const { operation } of [queue, cancel, withdraw]) {
      expect(
        Address.fromScAddress(operation.func.invokeContract().contractAddress()).toString(),
      ).toBe(BACKSTOP)
      expect(operation.auth).toHaveLength(1)
    }
  })
})

describe('guard rails', () => {
  it('refuses a zero amount before touching the network', async () => {
    await expect(buildBackstopDepositXdr({ ...base, amountStroops: 0n })).rejects.toThrow(
      'greater than zero',
    )
    expect(mockGetAccount).not.toHaveBeenCalled()
    expect(mockSimulate).not.toHaveBeenCalled()
  })

  it('surfaces a simulation failure instead of submitting it', async () => {
    mockSimulate.mockResolvedValue({ _parsed: true, error: 'insufficient allowance' })

    await expect(buildBackstopWithdrawXdr({ ...base, amountStroops: 1n })).rejects.toThrow(
      /simulation failed/,
    )
    expect(mockSimulate).toHaveBeenCalled()
  })

  it('refuses a pool id that is not a Stellar address', async () => {
    await expect(
      buildBackstopDepositXdr({ ...base, poolId: 'CPOOL', amountStroops: 1n }),
    ).rejects.toThrow('Pool is not a valid Stellar address')
    expect(mockGetAccount).not.toHaveBeenCalled()
  })
})
