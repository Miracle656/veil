import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true })
Object.assign(globalThis, { TextEncoder, TextDecoder })

/**
 * A vehicle must not be able to sign something the screen never showed, so the
 * interesting assertions are about units: LP tokens going into `deposit`,
 * shares going into queue/cancel/withdraw, and the two never being confused.
 */

const mockGetAccount = jest.fn()
const mockSimulate = jest.fn()
const mockDeposit = jest.fn()
const mockQueueWithdrawal = jest.fn()
const mockDequeueWithdrawal = jest.fn()
const mockWithdraw = jest.fn()

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk')
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: jest.fn().mockImplementation(() => ({
        getAccount: mockGetAccount,
        simulateTransaction: mockSimulate,
      })),
      // Assembly needs a full RPC simulation response; the builders are not
      // what this suite is checking, so it is stubbed to a fixed envelope.
      assembleTransaction: jest.fn(() => ({
        build: () => ({ toXDR: () => 'assembled-envelope' }),
      })),
    },
  }
})

jest.mock('../network', () => ({
  getNetwork: () => ({
    name: 'mainnet',
    displayName: 'Mainnet',
    rpcUrl: 'https://rpc.invalid',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
  }),
}))

jest.mock('@blend-capital/blend-sdk', () => ({
  BackstopContractV2: jest.fn().mockImplementation(() => ({
    deposit: mockDeposit,
    queueWithdrawal: mockQueueWithdrawal,
    dequeueWithdrawal: mockDequeueWithdrawal,
    withdraw: mockWithdraw,
  })),
  Backstop: { load: jest.fn() },
  BackstopPoolV2: { load: jest.fn() },
  BackstopPoolUser: { load: jest.fn() },
  BackstopPoolUserEst: { build: jest.fn() },
}))

jest.mock('../blend', () => ({ configuredPoolIds: jest.fn(() => ['CPOOL']) }))

import { xdr } from '@stellar/stellar-sdk'
import {
  Backstop,
  BackstopPoolUser,
  BackstopPoolUserEst,
  BackstopPoolV2,
} from '@blend-capital/blend-sdk'

import {
  buildBackstopCancelWithdrawalXdr,
  buildBackstopDepositXdr,
  buildBackstopQueueWithdrawalXdr,
  buildBackstopWithdrawXdr,
  configuredBackstopId,
  loadBackstopPosition,
  sharesToStroops,
  stroopsToShares,
} from '../backstop'

const BACKSTOP = 'CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7'
const POOL = 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD'
const USER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

function fakeOperation() {
  // Any well-formed invocation will do: the builders only parse it back into
  // an operation and wrap it in a transaction, which is never submitted here.
  return new (jest.requireActual('@stellar/stellar-sdk').Contract)(POOL)
    .call('noop')
    .toXDR('base64')
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetAccount.mockResolvedValue({
    accountId: () => USER,
    sequenceNumber: () => '1',
  })
  mockSimulate.mockResolvedValue({ result: { retval: xdr.ScVal.scvI128(new xdr.Int128Parts({
    hi: xdr.Int64.fromString('0'),
    lo: xdr.Uint64.fromString('0'),
  })) } })
  mockDeposit.mockReturnValue(fakeOperation())
  mockQueueWithdrawal.mockReturnValue(fakeOperation())
  mockDequeueWithdrawal.mockReturnValue(fakeOperation())
  mockWithdraw.mockReturnValue(fakeOperation())
})

describe('share amounts', () => {
  it('converts every supported decimal shape to stroops', () => {
    expect(sharesToStroops('1')).toBe(10_000_000n)
    expect(sharesToStroops('0.0000001')).toBe(1n)
    expect(sharesToStroops('1234.5')).toBe(12_345_000_000n)
  })

  it('refuses zero, negatives, and precision the contract cannot represent', () => {
    expect(() => sharesToStroops('0')).toThrow('greater than zero')
    expect(() => sharesToStroops('-1')).toThrow()
    expect(() => sharesToStroops('1.00000001')).toThrow()
    expect(() => sharesToStroops('abc')).toThrow()
  })

  it('round-trips without losing a stroop', () => {
    for (const value of ['1', '0.5', '1042.0000001']) {
      expect(stroopsToShares(sharesToStroops(value))).toBe(value)
    }
    expect(stroopsToShares(0n)).toBe('0')
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
    expect(position.queued).toEqual([{ amount: 4, exp: 1_800_000_000 }])
    expect(position.totalQueued).toBe(4)
    expect(position.unlockedQueued).toBe(0)
    expect(position.unlockedShares).toBe(40_000_000n)
  })

  it('rejects an address that is not a Stellar address', async () => {
    await expect(
      loadBackstopPosition({ poolId: 'not-an-address', userId: USER }),
    ).rejects.toThrow('Pool is not a valid Stellar address')
  })
})

describe('transaction builders', () => {
  const base = {
    backstopId: BACKSTOP,
    poolId: POOL,
    sourceAddress: USER,
    from: USER,
  }

  it('sends LP tokens to deposit', async () => {
    const xdrString = await buildBackstopDepositXdr({ ...base, amountStroops: 4_200_000_000n })
    expect(mockDeposit).toHaveBeenCalledWith({
      from: USER,
      pool_address: POOL,
      amount: 4_200_000_000n,
    })
    expect(xdrString).toEqual(expect.any(String))
    // Assembled for submission, not left as an unsimulated envelope.
    expect(mockSimulate).toHaveBeenCalled()
    expect(xdrString).toBe('assembled-envelope')
  })

  it('sends shares to queue, cancel and withdraw', async () => {
    await buildBackstopQueueWithdrawalXdr({ ...base, amountStroops: 1_000_000n })
    await buildBackstopCancelWithdrawalXdr({ ...base, amountStroops: 2_000_000n })
    await buildBackstopWithdrawXdr({ ...base, amountStroops: 3_000_000n })

    expect(mockQueueWithdrawal).toHaveBeenCalledWith(expect.objectContaining({ amount: 1_000_000n }))
    // The contract calls cancellation `dequeue_withdrawal`; the screen calls it
    // cancel because that is what it does to the queue.
    expect(mockDequeueWithdrawal).toHaveBeenCalledWith(expect.objectContaining({ amount: 2_000_000n }))
    expect(mockWithdraw).toHaveBeenCalledWith(expect.objectContaining({ amount: 3_000_000n }))
  })

  it('refuses a zero amount before touching the network', async () => {
    await expect(
      buildBackstopDepositXdr({ ...base, amountStroops: 0n }),
    ).rejects.toThrow('greater than zero')
    expect(mockDeposit).not.toHaveBeenCalled()
  })

  it('surfaces a simulation failure instead of submitting it', async () => {
    // The RPC reports a failed simulation the way `isSimulationError` reads it.
    mockSimulate.mockResolvedValue({ error: 'insufficient allowance' })

    await expect(
      buildBackstopWithdrawXdr({ ...base, amountStroops: 1n }),
    ).rejects.toThrow(/simulation failed/)
    expect(mockWithdraw).toHaveBeenCalled()
  })
})
