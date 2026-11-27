// @stellar/stellar-sdk needs TextEncoder at module load; jsdom omits it.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

/**
 * #1308 — the quote/guard half of Soroswap liquidity.
 *
 * These tests pin the three refusals the issue calls out — a one-sided
 * balance, a slippage breach, and a pair with no pool — plus the maths the
 * confirm step shows: the proportional second amount, the LP minted, and both
 * payout amounts on removal.
 */

import { Account, Address, BASE_FEE, Keypair, Networks, Operation, StrKey, TransactionBuilder, nativeToScVal } from '@stellar/stellar-sdk'
import { SupportedProtocols } from '@soroswap/sdk'
import { getSoroswapClient } from '@/lib/soroswap'
import {
  addLiquiditySlippageBreach,
  buildAddLiquidityXdr,
  buildRemoveLiquidityXdr,
  formatStroops,
  getSoroswapLiquidityPool,
  heldStroops,
  liquidityBalanceIssue,
  lpForPercent,
  parseAmountToStroops,
  parseSoroswapPool,
  parseSoroswapPosition,
  quoteAddLiquidity,
  quoteRemoveLiquidity,
  readLpTotalSupply,
  removeLiquiditySlippageBreach,
  verifyLiquidityTransaction,
  type HeldBalance,
  type LiquidityTransactionExpectation,
  type SoroswapPoolView,
} from '../soroswapLiquidity'

jest.mock('@/lib/soroswap', () => ({
  getSoroswapClient: jest.fn(),
  getSoroswapNetwork: jest.fn(() => 'testnet'),
}))

/**
 * Contract and account addresses are generated per run rather than committed
 * as literals: nothing in this file should look like a live identifier.
 */
function randomContract(): string {
  return StrKey.encodeContract(Keypair.random().rawPublicKey())
}

const TOKEN_A = randomContract() // stands in for an XLM SAC
const TOKEN_B = randomContract() // stands in for a USDC SAC
const POOL_ADDRESS = randomContract()

const client = {
  getPoolByTokens: jest.fn(),
  addLiquidity: jest.fn(),
  removeLiquidity: jest.fn(),
  getUserPositions: jest.fn(),
  getTokenBalance: jest.fn(),
}

const XLM = { code: 'XLM', issuer: null }
const USDC = { code: 'USDC', issuer: Keypair.random().publicKey() }

/** A router call shaped exactly like the Soroswap router interface. */
function liquidityXdr(params: {
  fn: 'add_liquidity' | 'remove_liquidity'
  to: string
  minA: bigint
  minB: bigint
  tokenA?: string
}): string {
  const account = new Account(Keypair.random().publicKey(), '0')
  const tokens = [
    new Address(params.tokenA ?? TOKEN_A).toScVal(),
    new Address(TOKEN_B).toScVal(),
  ]
  const tail = [
    nativeToScVal(params.minA, { type: 'i128' }),
    nativeToScVal(params.minB, { type: 'i128' }),
    new Address(params.to).toScVal(),
    nativeToScVal(1_800_000_000, { type: 'u64' }),
  ]
  const args =
    params.fn === 'add_liquidity'
      ? [
          ...tokens,
          nativeToScVal(1_000_0000000n, { type: 'i128' }),
          nativeToScVal(500_0000000n, { type: 'i128' }),
          ...tail,
        ]
      : [...tokens, nativeToScVal(250_0000000n, { type: 'i128' }), ...tail]
  return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.invokeContractFunction({ contract: POOL_ADDRESS, function: params.fn, args }),
    )
    .setTimeout(30)
    .build()
    .toXDR()
}

function pool(overrides: Partial<SoroswapPoolView> = {}): SoroswapPoolView {
  return {
    address: POOL_ADDRESS,
    tokenA: TOKEN_A,
    tokenB: TOKEN_B,
    reserveA: 1_000_0000000n, // 1000 XLM
    reserveB: 500_0000000n, // 500 USDC, so 1 XLM = 0.5 USDC
    lpSupply: null,
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(getSoroswapClient as jest.Mock).mockReturnValue(client)
})

describe('finding the pool', () => {
  it('quotes the pool the pair actually has, in the requested token order', async () => {
    client.getPoolByTokens.mockResolvedValue([
      {
        protocol: SupportedProtocols.SOROSWAP,
        address: POOL_ADDRESS,
        tokenA: TOKEN_A,
        tokenB: TOKEN_B,
        reserveA: '10000000000',
        reserveB: '5000000000',
      },
    ])
    const lookup = await getSoroswapLiquidityPool(TOKEN_A, TOKEN_B, 'XLM', 'USDC')
    expect(lookup).toMatchObject({ ok: true, pool: { address: POOL_ADDRESS } })
  })

  it('reports a nonexistent pair as having no pool, without inventing one', async () => {
    client.getPoolByTokens.mockResolvedValue([])
    const lookup = await getSoroswapLiquidityPool(TOKEN_A, TOKEN_B, 'XLM', 'USDC')
    expect(lookup).toEqual({
      ok: false,
      kind: 'none',
      reason:
        'No Soroswap pool exists for XLM / USDC. Veil does not create or guess a pool — choose a pair the wallet already holds assets for.',
    })
  })

  it('discards a pool record for different tokens', async () => {
    client.getPoolByTokens.mockResolvedValue([
      {
        protocol: SupportedProtocols.SOROSWAP,
        address: POOL_ADDRESS,
        tokenA: TOKEN_B,
        tokenB: 'COTHER',
        reserveA: '1',
        reserveB: '1',
      },
    ])
    expect(await getSoroswapLiquidityPool(TOKEN_A, TOKEN_B, 'XLM', 'USDC')).toMatchObject({
      ok: false,
      kind: 'mismatch',
    })
  })

  it('says so when this build has no Soroswap client', async () => {
    ;(getSoroswapClient as jest.Mock).mockReturnValue(null)
    expect(await getSoroswapLiquidityPool(TOKEN_A, TOKEN_B, 'XLM', 'USDC')).toMatchObject({
      ok: false,
      kind: 'unavailable',
    })
  })

  it('accepts a pool record whose reserves are in reverse token order', () => {
    const parsed = parseSoroswapPool(
      { protocol: 'soroswap', address: POOL_ADDRESS, tokenA: TOKEN_B, tokenB: TOKEN_A, reserveA: '7', reserveB: '9' },
      TOKEN_A,
      TOKEN_B,
    )
    expect(parsed).toMatchObject({ reserveA: 9n, reserveB: 7n })
  })
})

describe('one-sided balance is explained early', () => {
  const balances = (entries: Array<[string, string | null, string]>): HeldBalance[] =>
    entries.map(([code, issuer, balance]) => ({ code, issuer, balance }))

  it('explains holding one side, and names the missing asset', () => {
    const note = liquidityBalanceIssue({
      pairA: XLM,
      pairB: USDC,
      labelA: 'XLM',
      labelB: 'USDC',
      balances: balances([['XLM', null, '12.0']]),
    })
    expect(note).toBe(
      'You hold XLM but no USDC. A Soroswap pool takes both assets at its current ratio, so this add needs USDC as well as XLM.',
    )
  })

  it('explains holding neither side', () => {
    expect(
      liquidityBalanceIssue({
        pairA: XLM,
        pairB: USDC,
        labelA: 'XLM',
        labelB: 'USDC',
        balances: [],
      }),
    ).toMatch(/hold neither XLM nor USDC/)
  })

  it('explains a balance that is short of the ratio requirement, not just empty', () => {
    const note = liquidityBalanceIssue({
      pairA: XLM,
      pairB: USDC,
      labelA: 'XLM',
      labelB: 'USDC',
      balances: balances([
        ['XLM', null, '10'],
        ['USDC', USDC.issuer, '2'],
      ]),
      requiredB: 500_0000000n,
    })
    expect(note).toBe(
      "This deposit needs 500 USDC at the pool's ratio, but you hold 2 USDC. Lower the XLM amount or add USDC first.",
    )
  })

  it('is silent when both sides cover the quote', () => {
    expect(
      liquidityBalanceIssue({
        pairA: XLM,
        pairB: USDC,
        labelA: 'XLM',
        labelB: 'USDC',
        balances: balances([
          ['XLM', null, '10'],
          ['USDC', USDC.issuer, '5'],
        ]),
        requiredA: 1_0000000n,
        requiredB: 1_0000000n,
      }),
    ).toBeNull()
  })

  it('matches a held asset by issuer, not by code alone', () => {
    const impostor = Keypair.random().publicKey()
    expect(heldStroops([{ code: 'USDC', issuer: impostor, balance: '9' }], USDC)).toBe(0n)
  })
})

describe('add liquidity quote', () => {
  it('derives the second amount from reserves, mints the proportional LP and shows both shares', () => {
    const result = quoteAddLiquidity(pool({ lpSupply: 1_000_0000000n }), 100_0000000n, 50, 0n, 1_000_0000000n)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.quote.amountB).toBe(50_0000000n) // 1 XLM = 0.5 USDC
    expect(result.quote.mintedLp).toBe(100_0000000n) // 10% of reserves mints 10% of supply
    expect(result.quote.shareBefore).toBe(0)
    // 100 of 1000 LP minted against a 1000 supply leaves 100 / 1100 after.
    expect(result.quote.shareAfter).toBeCloseTo(100 / 1100, 10)
    expect(result.quote.minB).toBe(49_7500000n) // 0.5% slippage
  })

  it('adds the new LP to an existing position when showing the resulting share', () => {
    const result = quoteAddLiquidity(pool({ lpSupply: 1_000_0000000n }), 100_0000000n, 50, 100_0000000n, 1_000_0000000n)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.quote.shareBefore).toBeCloseTo(0.1, 10)
    expect(result.quote.shareAfter).toBeCloseTo(200 / 1100, 10)
  })

  it('says the LP minted cannot be shown when supply is unknown, rather than guessing', () => {
    const result = quoteAddLiquidity(pool(), 100_0000000n, 50, 0n, null)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.quote.mintedLp).toBeNull()
    expect(result.quote.shareAfter).toBeNull()
  })
})

describe('slippage breach', () => {
  it('refuses an add whose second amount moved beyond the reviewed tolerance', () => {
    const reviewed = quoteAddLiquidity(pool(), 100_0000000n, 50, 0n, null)
    expect(reviewed.ok).toBe(true)
    if (!reviewed.ok) return
    // 50 USDC reviewed, 0.5% allowance = 50.25 USDC.
    expect(addLiquiditySlippageBreach(reviewed.quote, 50_2000000n, 50)).toBeNull()
    expect(addLiquiditySlippageBreach(reviewed.quote, 51_0000000n, 50)).toMatch(
      /above the 50\.25 you approved at 0\.5% slippage/,
    )
  })

  it('refuses a removal whose payout fell below the reviewed minimum', () => {
    const reviewed = quoteRemoveLiquidity(pool({ lpSupply: 1_000_0000000n }), 100_0000000n, 50, 1_000_0000000n, 100_0000000n)
    expect(reviewed.ok).toBe(true)
    if (!reviewed.ok) return
    const current = quoteRemoveLiquidity(pool({ lpSupply: 1_000_0000000n }), 100_0000000n, 50, 1_000_0000000n, 100_0000000n)
    expect(current.ok).toBe(true)
    if (!current.ok) return
    expect(removeLiquiditySlippageBreach(reviewed.quote, current.quote, 50)).toBeNull()

    const moved = { ...current.quote, amountA: reviewed.quote.minA - 1n }
    expect(removeLiquiditySlippageBreach(reviewed.quote, moved, 50)).toMatch(/less than the minimum/)
  })
})

describe('remove liquidity quote', () => {
  it('states the expected amounts of both assets', () => {
    const result = quoteRemoveLiquidity(pool({ lpSupply: 1_000_0000000n }), 250_0000000n, 50, 1_000_0000000n, 500_0000000n)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.quote.amountA).toBe(250_0000000n)
    expect(result.quote.amountB).toBe(125_0000000n)
    expect(result.quote.minA).toBe(248_7500000n)
    expect(result.quote.minB).toBe(124_3750000n)
    expect(result.quote.shareBurned).toBeCloseTo(0.25, 10)
  })

  it('refuses more LP than the account holds', () => {
    const result = quoteRemoveLiquidity(pool({ lpSupply: 1_000_0000000n }), 600_0000000n, 50, 1_000_0000000n, 500_0000000n)
    expect(result).toEqual({
      ok: false,
      reason: 'You cannot remove more LP tokens than this account holds.',
    })
  })

  it('refuses to quote a payout against an unknown LP supply', () => {
    expect(quoteRemoveLiquidity(pool(), 1n, 50, null, 1n)).toMatchObject({ ok: false })
  })
})

describe('building the transactions', () => {
  it('builds an add with exactly the reviewed amounts and returns the XDR', async () => {
    client.addLiquidity.mockResolvedValue({
      xdr: 'ADD_XDR',
      type: 'add_liquidity',
      poolInfo: { address: POOL_ADDRESS },
      minAmountA: '995000000',
      minAmountB: '497500000',
    })
    const result = await buildAddLiquidityXdr({
      tokenA: TOKEN_A,
      tokenB: TOKEN_B,
      amountA: 1_0000000n,
      amountB: 500_0000n,
      to: 'GTEST',
      slippageBps: 50,
    })
    expect(client.addLiquidity).toHaveBeenCalledWith(
      {
        assetA: TOKEN_A,
        assetB: TOKEN_B,
        amountA: 1_0000000n,
        amountB: 500_0000n,
        to: 'GTEST',
        slippageBps: '50',
      },
      'testnet',
    )
    expect(result).toMatchObject({ ok: true, built: { xdr: 'ADD_XDR' } })
  })

  it('builds a removal with both expected amounts', async () => {
    client.removeLiquidity.mockResolvedValue({
      xdr: 'REMOVE_XDR',
      type: 'remove_liquidity',
      poolInfo: { address: POOL_ADDRESS },
      minAmountA: '1',
      minAmountB: '1',
    })
    const result = await buildRemoveLiquidityXdr({
      tokenA: TOKEN_A,
      tokenB: TOKEN_B,
      liquidity: 250_0000000n,
      amountA: 250_0000000n,
      amountB: 125_0000000n,
      to: 'GTEST',
      slippageBps: 50,
    })
    expect(client.removeLiquidity).toHaveBeenCalledWith(
      expect.objectContaining({
        liquidity: 250_0000000n,
        amountA: 250_0000000n,
        amountB: 125_0000000n,
      }),
      'testnet',
    )
    expect(result).toMatchObject({ ok: true, built: { xdr: 'REMOVE_XDR' } })
  })

  it('surfaces the router reason instead of a generic failure', async () => {
    client.addLiquidity.mockRejectedValue({ message: 'Missing trustline for USDC' })
    expect(
      await buildAddLiquidityXdr({
        tokenA: TOKEN_A,
        tokenB: TOKEN_B,
        amountA: 1n,
        amountB: 1n,
        to: 'GTEST',
        slippageBps: 50,
      }),
    ).toEqual({ ok: false, reason: 'Missing trustline for USDC' })
  })
})

describe('the transaction is checked against the reviewed quote before signing', () => {
  const to = Keypair.random().publicKey()
  const expected = {
    action: 'add_liquidity' as const,
    tokenA: TOKEN_A,
    tokenB: TOKEN_B,
    to,
    minAmountA: 995_0000000n,
    minAmountB: 497_5000000n,
  }

  const verify = (xdr: string, expectation: LiquidityTransactionExpectation = expected) =>
    verifyLiquidityTransaction({ xdr, networkPassphrase: Networks.TESTNET, expected: expectation })

  it('accepts the router call that matches the review', () => {
    const xdr = liquidityXdr({
      fn: 'add_liquidity',
      to,
      minA: expected.minAmountA,
      minB: expected.minAmountB,
    })
    expect(verify(xdr)).toBeNull()
  })

  it('refuses a transaction that calls the other router function', () => {
    const xdr = liquidityXdr({
      fn: 'remove_liquidity',
      to,
      minA: expected.minAmountA,
      minB: expected.minAmountB,
    })
    expect(verify(xdr)).toMatch(/instead of add_liquidity/)
  })

  it('refuses a transaction that sends the position to another account', () => {
    const xdr = liquidityXdr({
      fn: 'add_liquidity',
      to: Keypair.random().publicKey(),
      minA: expected.minAmountA,
      minB: expected.minAmountB,
    })
    expect(verify(xdr)).toMatch(/instead of your account/)
  })

  it('refuses a transaction built for different assets than the reviewed pair', () => {
    const xdr = liquidityXdr({
      fn: 'add_liquidity',
      tokenA: randomContract(),
      to,
      minA: expected.minAmountA,
      minB: expected.minAmountB,
    })
    expect(verify(xdr)).toMatch(/different assets/)
  })

  it('refuses minimums below the reviewed quote', () => {
    const xdr = liquidityXdr({
      fn: 'add_liquidity',
      to,
      minA: expected.minAmountA - 1n,
      minB: expected.minAmountB,
    })
    expect(verify(xdr)).toMatch(/below the/)
  })

  it('accepts a removal whose minimums cover the reviewed quote', () => {
    const removal = {
      action: 'remove_liquidity' as const,
      tokenA: TOKEN_A,
      tokenB: TOKEN_B,
      to,
      minAmountA: 248_7500000n,
      minAmountB: 124_3750000n,
    }
    const xdr = liquidityXdr({
      fn: 'remove_liquidity',
      to,
      minA: removal.minAmountA,
      minB: removal.minAmountB,
    })
    expect(verify(xdr, removal)).toBeNull()
  })
})

describe('helpers', () => {
  it('parses a position record from either field name', () => {
    const raw = {
      poolInfo: {
        address: POOL_ADDRESS,
        tokenA: { address: TOKEN_A },
        tokenB: { address: TOKEN_B },
        totalSupply: '2000',
      },
      userPosition: '250',
    }
    expect(parseSoroswapPosition(raw)).toMatchObject({
      totalSupply: 2000n,
      userLp: 250n,
    })
  })

  it('converts whole units to stroops and back without float drift', () => {
    expect(parseAmountToStroops('1.2345678')).toBe(12_345678n)
    expect(parseAmountToStroops('0')).toBeNull()
    expect(parseAmountToStroops('1.12345678')).toBeNull()
    expect(formatStroops(12_345678n)).toBe('1.2345678')
    expect(formatStroops(500_0000000n)).toBe('500')
  })

  it('turns a percentage into an LP amount without floating point on the amount', () => {
    expect(lpForPercent(1_000_0000000n, 25)).toBe(250_0000000n)
    expect(lpForPercent(1_000_0000000n, 0)).toBe(0n)
    expect(lpForPercent(1_000_0000000n, 150)).toBe(1_000_0000000n)
  })

  it('returns null when the LP total supply cannot be read', async () => {
    expect(
      await readLpTotalSupply({
        poolAddress: POOL_ADDRESS,
        sourceAddress: 'GTEST',
        rpcUrl: 'not-a-url',
        networkPassphrase: 'Test SDF Network ; September 2015',
      }),
    ).toBeNull()
  })
})
