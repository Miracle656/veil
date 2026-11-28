import { Asset, Horizon, Keypair, Networks, scValToNative } from '@stellar/stellar-sdk';

import {
  DEFAULT_LIQUIDITY_SLIPPAGE_BPS,
  MAX_LIQUIDITY_SLIPPAGE_BPS,
  MIN_LIQUIDITY_SLIPPAGE_BPS,
  buildAddLiquidityArgs,
  buildRemoveLiquidityArgs,
  estimateAddLiquidity,
  estimateRemoveLiquidity,
  formatLiquidityAmount,
  integerSquareRoot,
  minimumAmount,
  parseLiquidityAmount,
  parseSlippagePercent,
  readLiquidityAssetBalance,
  readSoroswapPair,
  slippageFailureMessage,
  type SoroswapPairState,
} from '../soroswapLiquidity';

const mockSimulateRead = jest.fn();
jest.mock('../contractInvoke', () => ({
  simulateRead: (...args: unknown[]) => mockSimulateRead(...args),
}));
jest.mock('../network', () => ({
  getNetwork: () => ({
    name: 'testnet',
    networkPassphrase: 'Test SDF Network ; September 2015',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    horizonUrl: 'https://horizon-testnet.stellar.org',
  }),
}));

const XLM_ID = Asset.native().contractId(Networks.TESTNET);
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC_ID = new Asset('USDC', USDC_ISSUER).contractId(Networks.TESTNET);
const PAIR_ID = 'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD';
const FACTORY_ID = 'CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY';
const RECIPIENT = Keypair.random().publicKey();

function state(overrides: Partial<SoroswapPairState> = {}): SoroswapPairState {
  return {
    pairId: PAIR_ID,
    tokenAId: XLM_ID,
    tokenBId: USDC_ID,
    reserveA: 3_000_000_000n,
    reserveB: 5_000_000_000n,
    balanceA: 3_000_000_000n,
    balanceB: 5_000_000_000n,
    totalSupply: 1_000_000_000n,
    kLast: 0n,
    feesEnabled: false,
    decimalsA: 7,
    decimalsB: 7,
    lpDecimals: 7,
    ...overrides,
  };
}

function nativeValues(values: ReturnType<typeof buildAddLiquidityArgs>['args']): unknown[] {
  return values.map((value) => scValToNative(value));
}

describe('Soroswap liquidity math', () => {
  beforeEach(() => {
    mockSimulateRead.mockReset();
  });

  it('parses and formats amounts without floating-point conversion', () => {
    expect(parseLiquidityAmount('12.0000001')).toBe(120_000_001n);
    expect(formatLiquidityAmount(120_000_001n)).toBe('12.0000001');
    expect(() => parseLiquidityAmount('0.00000001')).toThrow(/7 decimal places/);
    expect(() => parseLiquidityAmount('0')).toThrow(/greater than zero/);
  });

  it('matches the pool ratio and mirrors integer-truncated LP minting and minima', () => {
    const quote = estimateAddLiquidity(state(), 300_000_001n, 50);

    expect(quote).toEqual({
      amountA: 300_000_001n,
      amountB: 500_000_001n,
      minimumA: 298_500_000n,
      minimumB: 497_500_000n,
      liquidity: 100_000_000n,
      supplyAfterProtocolFee: 1_000_000_000n,
      poolSharePercent: '9.0909',
    });
  });

  it('includes the pair contract fee mint when calculating the post-deposit share', () => {
    const quote = estimateAddLiquidity(
      state({ kLast: 9_000_000_000_000_000_000n, feesEnabled: true }),
      300_000_000n,
      50,
    );

    expect(quote.supplyAfterProtocolFee).toBeGreaterThan(1_000_000_000n);
    expect(quote.liquidity).toBeGreaterThan(100_000_000n);
  });

  it('refuses an empty pool rather than dividing by zero or estimating first liquidity', () => {
    expect(() =>
      estimateAddLiquidity(
        state({ reserveA: 0n, reserveB: 0n, totalSupply: 0n }),
        1_000_000n,
        50,
      ),
    ).toThrow(/First-liquidity deposits are not supported/);
  });

  it('computes both removal amounts and slippage minima with integer rounding', () => {
    const quote = estimateRemoveLiquidity(
      state({
        balanceA: 900_000_007n,
        balanceB: 2_000_000_003n,
        totalSupply: 1_000_000_000n,
      }),
      125_000_001n,
      125_000_001n,
      50,
    );

    expect(quote).toEqual({
      liquidity: 125_000_001n,
      amountA: 112_500_001n,
      amountB: 250_000_002n,
      minimumA: 111_937_500n,
      minimumB: 248_750_001n,
    });
  });

  it('supports removing the full account balance and rejects zero or excessive LP amounts', () => {
    expect(
      estimateRemoveLiquidity(state(), 1_000_000_000n, 1_000_000_000n, 50).amountA,
    ).toBe(3_000_000_000n);
    expect(() => estimateRemoveLiquidity(state(), 0n, 0n, 50)).toThrow(/greater than zero/);
    expect(() => estimateRemoveLiquidity(state(), 2n, 1n, 50)).toThrow(/Not enough LP tokens/);
  });

  it('validates slippage bounds and applies basis points using integer math', () => {
    expect(DEFAULT_LIQUIDITY_SLIPPAGE_BPS).toBe(50);
    expect(MIN_LIQUIDITY_SLIPPAGE_BPS).toBe(10);
    expect(MAX_LIQUIDITY_SLIPPAGE_BPS).toBe(500);
    expect(parseSlippagePercent('0.5')).toBe(50);
    expect(parseSlippagePercent('5.00')).toBe(500);
    expect(minimumAmount(10_001n, 50)).toBe(9_950n);
    expect(() => minimumAmount(1n, 50)).toThrow(/non-zero minimum/);
    expect(() => parseSlippagePercent('0')).toThrow(/between 0.10% and 5.00%/);
    expect(() => parseSlippagePercent('5.01')).toThrow(/between 0.10% and 5.00%/);
  });

  it('computes integer square roots and identifies router minimum-amount failures as slippage', () => {
    expect(integerSquareRoot(15n)).toBe(3n);
    expect(integerSquareRoot(16n)).toBe(4n);
    expect(slippageFailureMessage(new Error('HostError: Error(Contract, #505)'))).toMatch(
      /slippage limit.*Refresh the quote/i,
    );
    expect(slippageFailureMessage(new Error('network unavailable'))).toBeNull();
  });

  it('checks pair existence before reading or building any pair transaction', async () => {
    mockSimulateRead.mockResolvedValue(false);

    await expect(
      readSoroswapPair(
        { code: 'XLM', issuer: null },
        { code: 'USDC', issuer: USDC_ISSUER },
      ),
    ).resolves.toEqual({ kind: 'missing' });
    expect(mockSimulateRead).toHaveBeenCalledTimes(1);
    expect(mockSimulateRead).toHaveBeenCalledWith(
      FACTORY_ID,
      'pair_exists',
      expect.any(Array),
    );
  });

  it('reads and orients a found pair by the selected assets', async () => {
    mockSimulateRead.mockImplementation(async (contract: string, method: string) => {
      if (contract === FACTORY_ID && method === 'pair_exists') return true;
      if (contract === FACTORY_ID && method === 'get_pair') return PAIR_ID;
      if (method === 'token_0') return USDC_ID;
      if (method === 'token_1') return XLM_ID;
      if (method === 'get_reserves') return [5_000_000_000n, 3_000_000_000n];
      if (method === 'total_supply') return 1_000_000_000n;
      if (method === 'k_last') return 0n;
      if (method === 'fees_enabled') return false;
      if (method === 'balance') return contract === USDC_ID ? 5_000_000_000n : 3_000_000_000n;
      if (method === 'decimals') return 7;
      throw new Error(`Unexpected read ${contract} ${method}`);
    });

    const result = await readSoroswapPair(
      { code: 'XLM', issuer: null },
      { code: 'USDC', issuer: USDC_ISSUER },
    );

    expect(result.kind).toBe('found');
    if (result.kind === 'found') {
      expect(result.pair).toMatchObject({
        pairId: PAIR_ID,
        tokenAId: XLM_ID,
        tokenBId: USDC_ID,
        reserveA: 3_000_000_000n,
        reserveB: 5_000_000_000n,
        balanceA: 3_000_000_000n,
        balanceB: 5_000_000_000n,
      });
    }
  });

  it('subtracts the live account reserve, liabilities, and fee buffer from spendable XLM', async () => {
    const loadAccount = jest
      .spyOn(Horizon.Server.prototype, 'loadAccount')
      .mockResolvedValue({
        balances: [{ asset_type: 'native', balance: '10.0000000', selling_liabilities: '0.1000000' }],
        subentry_count: 2,
      } as never);

    try {
      await expect(readLiquidityAssetBalance(Keypair.random().publicKey(), { code: 'XLM', issuer: null }))
        .resolves.toBe(78_500_000n);
    } finally {
      loadAccount.mockRestore();
    }
  });

  it('builds exact router parameter order and uses a five-minute Unix deadline', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const add = buildAddLiquidityArgs({
      assetA: XLM_ID,
      assetB: USDC_ID,
      amountA: 11n,
      amountB: 22n,
      minimumA: 10n,
      minimumB: 20n,
      recipient: RECIPIENT,
    });
    const remove = buildRemoveLiquidityArgs({
      assetA: XLM_ID,
      assetB: USDC_ID,
      liquidity: 33n,
      minimumA: 44n,
      minimumB: 55n,
      recipient: RECIPIENT,
    });

    expect(add.method).toBe('add_liquidity');
    expect(nativeValues(add.args)).toEqual([
      XLM_ID,
      USDC_ID,
      11n,
      22n,
      10n,
      20n,
      RECIPIENT,
      1_700_000_300n,
    ]);
    expect(remove.method).toBe('remove_liquidity');
    expect(remove.args.map((value) => scValToNative(value))).toEqual([
      XLM_ID,
      USDC_ID,
      33n,
      44n,
      55n,
      RECIPIENT,
      1_700_000_300n,
    ]);
    now.mockRestore();
  });
});
