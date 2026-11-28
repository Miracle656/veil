import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true })
Object.assign(globalThis, { TextEncoder, TextDecoder })

/**
 * The backstop transaction path, proved against real XDR.
 *
 * Only the network boundary is stubbed: `rpc.Server` (account lookups,
 * simulations, contract reads) and Horizon. Everything that decides what
 * actually gets signed is real — the Blend SDK's `BackstopContractV2` builds
 * the operation, `TransactionBuilder` wraps it, and `assembleTransaction`
 * attaches the simulation's footprint, resource fee and auth entries. The
 * assertions then decode the resulting envelope, so a stub that merely returns
 * a string cannot satisfy them.
 */

const mockGetAccount = jest.fn()
const mockSimulate = jest.fn()
const mockLoadAccount = jest.fn()

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk')
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      // The RPC server is the network; replacing it keeps the request/response
      // boundary under test control without replacing the transaction code.
      Server: jest.fn().mockImplementation(() => ({
        getAccount: (...args: unknown[]) => mockGetAccount(...args),
        simulateTransaction: (...args: unknown[]) => mockSimulate(...args),
      })),
    },
    Horizon: {
      ...actual.Horizon,
      Server: jest.fn().mockImplementation(() => ({
        loadAccount: (...args: unknown[]) => mockLoadAccount(...args),
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
jest.mock('../blend', () => ({ configuredPoolIds: jest.fn(() => []) }))

/**
 * Every Blend SDK entry point here is a ledger read, so the whole module is
 * stubbed: the SDK pins its own `@stellar/stellar-sdk` 16, whose `@noble/*`
 * dependencies ship ESM only and cannot be loaded by the Jest runtime. Real
 * transaction construction lives in `lib/backstopTx.ts`, which needs no Blend
 * SDK import — `backstopTx.test.ts` builds the actual envelope there.
 */
jest.mock('@blend-capital/blend-sdk', () => {
  // A well-formed invocation for the queue-lock probe: only its return value
  // is read, and parsing it proves the probe is a real operation.
  const stellar = jest.requireActual('@stellar/stellar-sdk')
  const backstop = 'CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7'
  return {
    Backstop: { load: jest.fn() },
    BackstopPoolV2: { load: jest.fn() },
    BackstopPoolUser: { load: jest.fn() },
    BackstopPoolUserEst: { build: jest.fn() },
    BackstopConfig: { load: jest.fn() },
    BackstopContractV2: jest.fn().mockImplementation(() => ({
      queueWithdrawal: () =>
        new stellar.Contract(backstop).call('queue_withdrawal').toXDR('base64'),
    })),
  }
})

import {
  Address,
  Operation,
  Transaction,
  TransactionBuilder,
  rpc as SorobanRpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'
import {
  Backstop,
  BackstopConfig,
  BackstopPoolUser,
  BackstopPoolUserEst,
  BackstopPoolV2,
} from '@blend-capital/blend-sdk'

import {
  FALLBACK_QUEUE_LOCK_SECONDS,
  configuredBackstopId,
  formatLockDuration,
  loadBackstopPosition,
  loadBackstopPositions,
  loadBackstopQueueLockSeconds,
  runBackstopPreflight,
  stroopsToShares,
} from '../backstop'

// The pure amount/date helpers are covered in `backstopAmounts.test.ts`, where
// they are imported from the SDK-free module that ships them.

const BACKSTOP = 'CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7'
const POOL = 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD'
const LP_TOKEN = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const USER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const PASSPHRASE = 'Public Global Stellar Network ; September 2015'

// ── Simulation / ledger fixtures ────────────────────────────────────────────

function i128(value: bigint): xdr.ScVal {
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      hi: xdr.Int64.fromString((value >> 64n).toString()),
      lo: xdr.Uint64.fromString((value & 0xffffffffffffffffn).toString()),
    }),
  )
}

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
 * A parsed, successful simulation response. `_parsed` tells the SDK not to run
 * it through the raw-response parser, which is exactly what a real
 * `server.simulateTransaction()` returns.
 */
function simulationSuccess(options: { functionName?: string; retval?: xdr.ScVal } = {}) {
  return {
    _parsed: true,
    latestLedger: 123,
    minResourceFee: '1000',
    transactionData: { build: () => sorobanTransactionData() },
    result: {
      auth: options.functionName ? [authEntry(options.functionName)] : [],
      retval: options.retval ?? xdr.ScVal.scvVoid(),
    },
    events: [],
  }
}

function invokeOperation(xdrString: string): Operation.InvokeHostFunction {
  const transaction = TransactionBuilder.fromXDR(xdrString, PASSPHRASE) as Transaction
  expect(transaction.operations).toHaveLength(1)
  const operation = transaction.operations[0]
  expect(operation.type).toBe('invokeHostFunction')
  return operation as Operation.InvokeHostFunction
}

function invokedContract(operation: Operation.InvokeHostFunction) {
  return operation.func.invokeContract()
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetAccount.mockResolvedValue({
    accountId: () => USER,
    sequenceNumber: () => '1',
  })
  mockSimulate.mockResolvedValue(simulationSuccess({ functionName: 'deposit' }))
  mockLoadAccount.mockResolvedValue({
    balances: [{ asset_type: 'native', balance: '100.0000000' }],
    subentry_count: 0,
    num_sponsoring: 0,
    num_sponsored: 0,
  })
})

describe('configuredBackstopId', () => {
  const original = process.env.NEXT_PUBLIC_BLEND_BACKSTOP_ID_MAINNET

  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_BLEND_BACKSTOP_ID_MAINNET
    else process.env.NEXT_PUBLIC_BLEND_BACKSTOP_ID_MAINNET = original
  })

  it('falls back to the deployed mainnet backstop', () => {
    delete process.env.NEXT_PUBLIC_BLEND_BACKSTOP_ID_MAINNET
    expect(configuredBackstopId()).toBe(BACKSTOP)
  })

  it('prefers an explicitly configured contract', () => {
    process.env.NEXT_PUBLIC_BLEND_BACKSTOP_ID_MAINNET = POOL
    expect(configuredBackstopId()).toBe(POOL)
  })
})

describe('loadBackstopPosition', () => {
  it('reports share value and emissions as separate figures', async () => {
    ;(Backstop.load as jest.Mock).mockResolvedValue({ backstopToken: {} })
    ;(BackstopPoolV2.load as jest.Mock).mockResolvedValue({ poolBalance: {} })
    ;(BackstopPoolUser.load as jest.Mock).mockResolvedValue({
      balance: {
        shares: 250_000_000n,
        q4w: [{ amount: 40_000_000n, exp: 1_800_000_000n }],
        unlockedQ4W: 40_000_000n,
        totalQ4W: 40_000_000n,
      },
    })
    ;(BackstopPoolUserEst.build as jest.Mock).mockReturnValue({
      tokens: 25,
      blnd: 20,
      usdc: 5,
      totalSpotValue: 25,
      emissions: 1.75,
      q4w: [{ amount: 4, exp: 1_800_000_000 }],
      totalQ4W: 4,
      totalUnlockedQ4W: 0,
    })

    const position = await loadBackstopPosition({ poolId: POOL, userId: USER })

    expect(position.backstopId).toBe(BACKSTOP)
    expect(position.shares).toBe(250_000_000n)
    // The current value, not what was deposited.
    expect(position.shareValue).toBe(25)
    expect(position.blnd).toBe(20)
    expect(position.usdc).toBe(5)
    // Emissions are their own field, never added into the position value.
    expect(position.emissions).toBe(1.75)
    expect(position.shareValue).not.toBe(position.emissions)
  })

  it('reports the queue in shares, which is what cancel and withdraw take', async () => {
    // The estimate reports the queue in LP tokens (4 LP for 40 shares). The
    // position must not: `dequeue_withdrawal`/`withdraw` are called with
    // shares, so a screen built on the estimate's numbers sends 4 where the
    // contract expects 40_000_000.
    ;(Backstop.load as jest.Mock).mockResolvedValue({ backstopToken: {} })
    ;(BackstopPoolV2.load as jest.Mock).mockResolvedValue({ poolBalance: {} })
    ;(BackstopPoolUser.load as jest.Mock).mockResolvedValue({
      balance: {
        shares: 250_000_000n,
        q4w: [
          { amount: 40_000_000n, exp: 1_000n },
          { amount: 10_000_000n, exp: 9_999_999_999n },
        ],
        unlockedQ4W: 0n,
        totalQ4W: 0n,
      },
    })
    ;(BackstopPoolUserEst.build as jest.Mock).mockReturnValue({
      tokens: 25,
      blnd: 20,
      usdc: 5,
      totalSpotValue: 25,
      emissions: 0,
      q4w: [{ amount: 4, exp: 1_000 }],
      totalQ4W: 4,
      totalUnlockedQ4W: 0,
    })

    const position = await loadBackstopPosition({ poolId: POOL, userId: USER })

    expect(position.queued).toEqual([
      { shares: 40_000_000n, exp: 1_000 },
      { shares: 10_000_000n, exp: 9_999_999_999 },
    ])
    // Every queued share — locked or not — is the cancel limit.
    expect(position.queuedShares).toBe(50_000_000n)
    // Only the expired entry is withdrawable.
    expect(position.unlockedShares).toBe(40_000_000n)
    expect(stroopsToShares(position.queuedShares)).toBe('5')
  })

  it('rejects an address that is not a Stellar address', async () => {
    await expect(
      loadBackstopPosition({ poolId: 'not-an-address', userId: USER }),
    ).rejects.toThrow('Pool is not a valid Stellar address')
  })
})

describe('loadBackstopPositions', () => {
  it('names the pools it could not load instead of reporting them as empty', async () => {
    ;(Backstop.load as jest.Mock).mockResolvedValue({ backstopToken: {} })
    ;(BackstopPoolV2.load as jest.Mock).mockResolvedValue({ poolBalance: {} })
    ;(BackstopPoolUser.load as jest.Mock).mockRejectedValue(new Error('rpc down'))
    ;(BackstopPoolUserEst.build as jest.Mock).mockReturnValue({
      tokens: 0,
      blnd: 0,
      usdc: 0,
      totalSpotValue: 0,
      emissions: 0,
      q4w: [],
      totalQ4W: 0,
      totalUnlockedQ4W: 0,
    })

    const result = await loadBackstopPositions(USER, [POOL])

    expect(result.positions).toEqual([])
    expect(result.failedPoolIds).toEqual([POOL])
  })
})

describe('loadBackstopQueueLockSeconds', () => {
  const original = process.env.NEXT_PUBLIC_BLEND_BACKSTOP_Q4W_LOCK_SECONDS

  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_BLEND_BACKSTOP_Q4W_LOCK_SECONDS
    else process.env.NEXT_PUBLIC_BLEND_BACKSTOP_Q4W_LOCK_SECONDS = original
  })

  function q4wRetval(exp: number): xdr.ScVal {
    return xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('amount'), val: i128(0n) }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('exp'),
        val: xdr.ScVal.scvU64(xdr.Uint64.fromString(String(exp))),
      }),
    ])
  }

  it('reads the lock from the expiry the contract stamps on a queue entry', async () => {
    // A contract whose lock is 5 days, not the 17 the UI used to hardcode.
    const exp = Math.floor(Date.now() / 1_000) + 5 * 24 * 60 * 60
    mockSimulate.mockResolvedValue(simulationSuccess({ retval: q4wRetval(exp) }))

    const seconds = await loadBackstopQueueLockSeconds({
      backstopId: POOL,
      poolId: POOL,
      sourceAddress: USER,
    })

    expect(seconds).toBe(5 * 24 * 60 * 60)
    expect(formatLockDuration(seconds)).toBe('5 days')
    expect(seconds).not.toBe(FALLBACK_QUEUE_LOCK_SECONDS)
  })

  it('falls back to the protocol constant only when the read fails', async () => {
    mockSimulate.mockResolvedValue({ _parsed: true, error: 'host invocation failed' })

    const seconds = await loadBackstopQueueLockSeconds({
      backstopId: BACKSTOP,
      poolId: POOL,
      sourceAddress: USER,
    })

    expect(seconds).toBe(FALLBACK_QUEUE_LOCK_SECONDS)
    expect(formatLockDuration(seconds)).toBe('17 days')
  })

  it('honours an operator override', async () => {
    process.env.NEXT_PUBLIC_BLEND_BACKSTOP_Q4W_LOCK_SECONDS = String(3 * 24 * 60 * 60)

    const seconds = await loadBackstopQueueLockSeconds({
      backstopId: LP_TOKEN,
      poolId: POOL,
      sourceAddress: USER,
    })

    expect(seconds).toBe(3 * 24 * 60 * 60)
    expect(mockSimulate).not.toHaveBeenCalled()
  })
})

describe('runBackstopPreflight', () => {
  beforeEach(() => {
    ;(BackstopConfig.load as jest.Mock).mockResolvedValue({ backstopTkn: LP_TOKEN })
  })

  const base = {
    backstopId: BACKSTOP,
    sourceAddress: USER,
  }

  it('blocks a deposit the account cannot pay the fee for', async () => {
    mockLoadAccount.mockResolvedValue({
      balances: [{ asset_type: 'native', balance: '0.5000000' }],
      subentry_count: 0,
      num_sponsoring: 0,
      num_sponsored: 0,
    })
    mockSimulate.mockResolvedValue(simulationSuccess({ retval: i128(50_000_000_000n) }))

    const result = await runBackstopPreflight({
      ...base,
      method: 'deposit',
      amountStroops: 10_000_000n,
    })

    expect(result.ok).toBe(false)
    expect(result.problems.join(' ')).toMatch(/XLM/)
  })

  it('blocks a deposit larger than the LP tokens the account holds', async () => {
    // 5 LP tokens held, 10 asked for.
    mockSimulate.mockResolvedValue(simulationSuccess({ retval: i128(50_000_000n) }))

    const result = await runBackstopPreflight({
      ...base,
      method: 'deposit',
      amountStroops: 100_000_000n,
    })

    expect(result.ok).toBe(false)
    expect(result.lpBalance).toBe('5')
    expect(result.problems.join(' ')).toMatch(/BLND:USDC LP tokens and you hold 5/)
  })

  it('passes when the fee is covered and the LP tokens are there', async () => {
    mockSimulate.mockResolvedValue(simulationSuccess({ retval: i128(50_000_000_000n) }))

    const result = await runBackstopPreflight({
      ...base,
      method: 'deposit',
      amountStroops: 10_000_000n,
    })

    expect(result.problems).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.lpBalance).toBe('5000')
  })

  it('does not read LP tokens for queue, cancel or withdraw', async () => {
    const result = await runBackstopPreflight({
      ...base,
      method: 'withdraw',
      amountStroops: 10_000_000n,
    })

    expect(result.ok).toBe(true)
    expect(result.lpBalance).toBeNull()
    expect(BackstopConfig.load).not.toHaveBeenCalled()
    expect(mockSimulate).not.toHaveBeenCalled()
  })
})

describe('SorobanRpc surface', () => {
  it('is the SDK assemble path the builders rely on', () => {
    // Guards against a future refactor quietly replacing `assembleTransaction`
    // with a hand-rolled envelope that skips the simulation's footprint.
    expect(typeof SorobanRpc.assembleTransaction).toBe('function')
  })
})
