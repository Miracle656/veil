import { Asset, Horizon, Keypair, Networks, scValToNative, StrKey } from '@stellar/stellar-sdk';
import { loadSoroswapLpPositions } from '../soroswapLpPositions';

const mockSimulateRead = jest.fn();
const mockGetFeePayerAddress = jest.fn();
const mockFetchPrice = jest.fn();

jest.mock('../contractInvoke', () => ({
  simulateRead: (...args: unknown[]) => mockSimulateRead(...args),
}));
jest.mock('../activity', () => ({ getFeePayerAddress: () => mockGetFeePayerAddress() }));
jest.mock('../network', () => ({
  getNetwork: () => ({
    name: 'mainnet',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
    horizonUrl: 'https://horizon.stellar.org',
  }),
}));
jest.mock('../fetchPrice', () => ({
  fetchPrice: (...args: unknown[]) => mockFetchPrice(...args),
  usdValue: (amount: string | number, price: number | null) =>
    price === null ? null : Number(amount) * price,
}));

const NETWORK = Networks.PUBLIC;
const WALLET = StrKey.encodeContract(Buffer.alloc(32, 0x33));
const FEE_PAYER = Keypair.random().publicKey();
const PAIR = StrKey.encodeContract(Buffer.alloc(32, 0x44));
const EMPTY_PAIR = StrKey.encodeContract(Buffer.alloc(32, 0x55));
const UNKNOWN_TOKEN_A = StrKey.encodeContract(Buffer.alloc(32, 0x66));
const UNKNOWN_TOKEN_B = StrKey.encodeContract(Buffer.alloc(32, 0x77));
const XLM = Asset.native().contractId(NETWORK);
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const USDC = new Asset('USDC', USDC_ISSUER).contractId(NETWORK);
let mockAssetRecords: { asset_code: string; asset_issuer: string }[] = [];

function nativeArg(arg: unknown): string {
  return String(scValToNative(arg as Parameters<typeof scValToNative>[0]));
}

describe('loadSoroswapLpPositions', () => {
  beforeEach(() => {
    mockSimulateRead.mockReset();
    mockGetFeePayerAddress.mockReset();
    mockFetchPrice.mockReset();
    mockGetFeePayerAddress.mockResolvedValue(FEE_PAYER);
    mockFetchPrice.mockImplementation(async (code: string) =>
      code === 'XLM' ? 0.1 : code === 'USDC' ? 1 : null
    );
    const assetQuery = {
      forCode: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      call: jest.fn(async () => ({ records: mockAssetRecords })),
    };
    mockAssetRecords = [];
    jest.spyOn(Horizon.Server.prototype, 'assets').mockReturnValue(assetQuery as never);
  });

  afterEach(() => jest.restoreAllMocks());

  it('discovers and values a held pair, combining smart-wallet and fee-payer balances', async () => {
    mockSimulateRead.mockImplementation(
      async (_contract: string, method: string, args: unknown[] = []) => {
        if (method === 'all_pairs_length') return 2;
        if (method === 'all_pairs')
          return Number(scValToNative(args[0] as Parameters<typeof scValToNative>[0])) === 0
            ? PAIR
            : EMPTY_PAIR;
        if (method === 'balance' && _contract === PAIR) {
          const owner = nativeArg(args[0]);
          if (owner === WALLET) return 200_000_000n;
          if (owner === FEE_PAYER) return 50_000_000n;
          return 0n;
        }
        if (method === 'balance') return 0n;
        if (method === 'token_0') return XLM;
        if (method === 'token_1') return USDC;
        if (method === 'get_reserves') return [50_000_000_000n, 120_000_000_000n];
        if (method === 'total_supply') return 10_000_000_000n;
        if (method === 'decimals') return 7;
        throw new Error(`Unexpected contract call: ${method}`);
      }
    );

    await expect(loadSoroswapLpPositions(WALLET)).resolves.toEqual([
      {
        pairId: PAIR,
        tokenAId: XLM,
        tokenBId: USDC,
        tokenA: 'XLM',
        tokenB: 'USDC',
        lpBalance: '25',
        lpBalanceRaw: '250000000',
        ownerBalances: [
          { address: WALLET, raw: '200000000' },
          { address: FEE_PAYER, raw: '50000000' },
        ],
        ownershipPercent: '2.50',
        underlyingA: '125',
        underlyingB: '300',
        usd: 312.5,
      },
    ]);
    expect(mockGetFeePayerAddress).toHaveBeenCalledTimes(1);
    expect(mockFetchPrice).toHaveBeenCalledWith('XLM', null);
    expect(mockFetchPrice).toHaveBeenCalledWith('USDC', USDC_ISSUER);
  });

  it('returns no positions for zero balances without reading pair reserves', async () => {
    mockSimulateRead.mockImplementation(async (_contract: string, method: string) => {
      if (method === 'all_pairs_length') return 1;
      if (method === 'all_pairs') return EMPTY_PAIR;
      if (method === 'balance') return 0n;
      throw new Error(`Unexpected contract call: ${method}`);
    });

    await expect(loadSoroswapLpPositions(FEE_PAYER)).resolves.toEqual([]);
    expect(mockSimulateRead).toHaveBeenCalledTimes(3);
  });

  it('shows amounts for unknown pair assets without inventing their prices', async () => {
    mockSimulateRead.mockImplementation(async (_contract: string, method: string) => {
      if (method === 'all_pairs_length') return 1;
      if (method === 'all_pairs') return PAIR;
      if (method === 'balance') return 2_500_000n;
      if (method === 'token_0') return UNKNOWN_TOKEN_A;
      if (method === 'token_1') return UNKNOWN_TOKEN_B;
      if (method === 'symbol') return _contract === UNKNOWN_TOKEN_A ? 'FOO' : 'BAR';
      if (method === 'get_reserves') return [2_500_000n, 1_000_000_000n];
      if (method === 'total_supply') return 10_000_000n;
      if (method === 'decimals')
        return _contract === UNKNOWN_TOKEN_A ? 6 : _contract === UNKNOWN_TOKEN_B ? 8 : 7;
      throw new Error(`Unexpected contract call: ${method}`);
    });

    await expect(loadSoroswapLpPositions(FEE_PAYER)).resolves.toEqual([
      {
        pairId: PAIR,
        tokenAId: UNKNOWN_TOKEN_A,
        tokenBId: UNKNOWN_TOKEN_B,
        tokenA: 'FOO',
        tokenB: 'BAR',
        lpBalance: '0.25',
        lpBalanceRaw: '2500000',
        ownerBalances: [{ address: FEE_PAYER, raw: '2500000' }],
        ownershipPercent: '25.00',
        underlyingA: '0.625',
        underlyingB: '2.5',
        usd: null,
      },
    ]);
    expect(mockFetchPrice).not.toHaveBeenCalled();
  });

  it('resolves an unregistered Stellar asset by matching its SAC against Horizon issuers', async () => {
    const issuer = Keypair.random().publicKey();
    const token = new Asset('ALPHA', issuer).contractId(NETWORK);
    mockAssetRecords = [{ asset_code: 'ALPHA', asset_issuer: issuer }];
    mockFetchPrice.mockImplementation(async (code: string) => (code === 'ALPHA' ? 2 : 1));
    mockSimulateRead.mockImplementation(async (_contract: string, method: string) => {
      if (method === 'all_pairs_length') return 1;
      if (method === 'all_pairs') return PAIR;
      if (method === 'balance') return 10_000_000n;
      if (method === 'token_0') return token;
      if (method === 'token_1') return USDC;
      if (method === 'symbol') return 'ALPHA';
      if (method === 'get_reserves') return [1_000_000_000n, 20_000_000_000n];
      if (method === 'total_supply') return 100_000_000n;
      if (method === 'decimals') return _contract === token ? 6 : 7;
      throw new Error(`Unexpected contract call: ${method}`);
    });

    await expect(loadSoroswapLpPositions(FEE_PAYER)).resolves.toEqual([
      {
        pairId: PAIR,
        tokenAId: token,
        tokenBId: USDC,
        tokenA: 'ALPHA',
        tokenB: 'USDC',
        lpBalance: '1',
        lpBalanceRaw: '10000000',
        ownerBalances: [{ address: FEE_PAYER, raw: '10000000' }],
        ownershipPercent: '10.00',
        underlyingA: '100',
        underlyingB: '200',
        usd: 400,
      },
    ]);
    expect(mockFetchPrice).toHaveBeenCalledWith('ALPHA', issuer);
  });

  it('surfaces a failed factory read instead of presenting it as an empty portfolio', async () => {
    mockSimulateRead.mockResolvedValue(null);

    await expect(loadSoroswapLpPositions(FEE_PAYER)).rejects.toThrow(
      'Could not read Soroswap all_pairs_length'
    );
  });
});
