/**
 * Blend read-path tests.
 *
 * The Blend SDK and the Stellar SDK are both mocked: what matters here is how
 * reserves become the `BlendPool` / `BlendPosition` shapes the earn screen
 * renders, and that one unreachable pool cannot take the whole screen down.
 */

jest.mock('@stellar/stellar-sdk', () => ({
  Networks: {
    TESTNET: 'Test SDF Network ; September 2015',
    PUBLIC: 'Public Global Stellar Network ; September 2015',
  },
  Account: class {},
  BASE_FEE: '100',
  TransactionBuilder: class {},
  xdr: { Operation: { fromXDR: () => ({}) } },
  rpc: {
    Server: class {},
    Api: { isSimulationError: () => false },
    assembleTransaction: () => ({}),
  },
}));

const mockPoolV2Load = jest.fn();
const mockPoolV1Load = jest.fn();

jest.mock('@blend-capital/blend-sdk', () => ({
  PoolV2: { load: (...args: unknown[]) => mockPoolV2Load(...args) },
  PoolV1: { load: (...args: unknown[]) => mockPoolV1Load(...args) },
  PoolContractV1: class {},
  PoolContractV2: class {},
  RequestType: { Supply: 2, Withdraw: 3 },
}));

import { loadBlendPools, loadBlendPositions } from '../blend';

type ReserveStub = { assetId: string; supply: bigint; apy: number };

function reserve({ assetId, supply, apy }: ReserveStub) {
  return { assetId, totalSupply: () => supply, estSupplyApy: apy };
}

function poolStub(options: {
  id: string;
  name?: string;
  reserves: ReserveStub[];
  supply?: Record<string, { bTokens: bigint; deposited: bigint }>;
}) {
  const reserves = options.reserves.map(reserve);
  return {
    id: options.id,
    metadata: {
      name: options.name ?? '',
      reserveList: options.reserves.map((r) => r.assetId),
    },
    reserves: new Map(reserves.map((r) => [r.assetId, r])),
    loadUser: async () => ({
      getSupplyBTokens: (r: { assetId: string }) => options.supply?.[r.assetId]?.bTokens ?? 0n,
      getSupply: (r: { assetId: string }) => options.supply?.[r.assetId]?.deposited ?? 0n,
    }),
  };
}

describe('blend', () => {
  const originalPoolIds = process.env['EXPO_PUBLIC_BLEND_POOL_IDS'];

  beforeEach(() => {
    mockPoolV2Load.mockReset();
    mockPoolV1Load.mockReset();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalPoolIds === undefined) delete process.env['EXPO_PUBLIC_BLEND_POOL_IDS'];
    else process.env['EXPO_PUBLIC_BLEND_POOL_IDS'] = originalPoolIds;
  });

  describe('loadBlendPools', () => {
    it('returns nothing and does not call the network when no pools are configured', async () => {
      delete process.env['EXPO_PUBLIC_BLEND_POOL_IDS'];

      await expect(loadBlendPools()).resolves.toEqual([]);
      expect(mockPoolV2Load).not.toHaveBeenCalled();
    });

    it('averages the reserve APYs and sums total supply', async () => {
      process.env['EXPO_PUBLIC_BLEND_POOL_IDS'] = 'CPOOL1';
      mockPoolV2Load.mockResolvedValue(
        poolStub({
          id: 'CPOOL1',
          name: 'Testnet USDC',
          reserves: [
            { assetId: 'CUSDC', supply: 1_000n, apy: 0.04 },
            { assetId: 'CXLM', supply: 500n, apy: 0.06 },
          ],
        })
      );

      const [pool] = await loadBlendPools();

      expect(pool).toEqual({
        id: 'CPOOL1',
        name: 'Testnet USDC',
        supplyApy: 0.05,
        totalSupply: '1500',
        assets: ['CUSDC', 'CXLM'],
      });
    });

    it('falls back to a truncated id when the pool has no name', async () => {
      process.env['EXPO_PUBLIC_BLEND_POOL_IDS'] = 'CPOOLABCDEFGH';
      mockPoolV2Load.mockResolvedValue(
        poolStub({ id: 'CPOOLABCDEFGH', reserves: [{ assetId: 'CUSDC', supply: 1n, apy: 0 }] })
      );

      const [pool] = await loadBlendPools();

      expect(pool.name).toBe('CPOOLABC');
    });

    it('falls back to the V1 pool contract when V2 rejects', async () => {
      process.env['EXPO_PUBLIC_BLEND_POOL_IDS'] = 'CPOOL1';
      mockPoolV2Load.mockRejectedValue(new Error('not a v2 pool'));
      mockPoolV1Load.mockResolvedValue(
        poolStub({ id: 'CPOOL1', name: 'V1', reserves: [{ assetId: 'CUSDC', supply: 7n, apy: 0.1 }] })
      );

      const [pool] = await loadBlendPools();

      expect(pool.name).toBe('V1');
      expect(pool.totalSupply).toBe('7');
    });

    it('drops a pool that cannot be loaded rather than failing the whole list', async () => {
      process.env['EXPO_PUBLIC_BLEND_POOL_IDS'] = 'CBROKEN,CPOOL1';
      mockPoolV2Load.mockRejectedValue(new Error('rpc down'));
      mockPoolV1Load.mockImplementation(async (_network: unknown, poolId: string) => {
        if (poolId === 'CBROKEN') throw new Error('rpc down');
        return poolStub({ id: poolId, name: 'Healthy', reserves: [{ assetId: 'CUSDC', supply: 1n, apy: 0 }] });
      });

      const pools = await loadBlendPools();

      expect(pools).toHaveLength(1);
      expect(pools[0].id).toBe('CPOOL1');
    });

    it('reports a zero APY for a pool with no reserves instead of NaN', async () => {
      process.env['EXPO_PUBLIC_BLEND_POOL_IDS'] = 'CEMPTY';
      mockPoolV2Load.mockResolvedValue(poolStub({ id: 'CEMPTY', name: 'Empty', reserves: [] }));

      const [pool] = await loadBlendPools();

      expect(pool.supplyApy).toBe(0);
      expect(pool.totalSupply).toBe('0');
    });
  });

  describe('loadBlendPositions', () => {
    it('keeps only reserves the user actually supplied', async () => {
      process.env['EXPO_PUBLIC_BLEND_POOL_IDS'] = 'CPOOL1';
      mockPoolV2Load.mockResolvedValue(
        poolStub({
          id: 'CPOOL1',
          reserves: [
            { assetId: 'CUSDC', supply: 1_000n, apy: 0.04 },
            { assetId: 'CXLM', supply: 500n, apy: 0.06 },
          ],
          supply: { CUSDC: { bTokens: 100n, deposited: 130n } },
        })
      );

      const positions = await loadBlendPositions('GUSER');

      expect(positions).toEqual([
        {
          poolId: 'CPOOL1',
          asset: 'CUSDC',
          deposited: '130',
          bTokenBalance: '100',
          accruedInterest: '30',
        },
      ]);
    });

    it('never reports negative accrued interest', async () => {
      process.env['EXPO_PUBLIC_BLEND_POOL_IDS'] = 'CPOOL1';
      mockPoolV2Load.mockResolvedValue(
        poolStub({
          id: 'CPOOL1',
          reserves: [{ assetId: 'CUSDC', supply: 1_000n, apy: 0.04 }],
          supply: { CUSDC: { bTokens: 100n, deposited: 90n } },
        })
      );

      const [position] = await loadBlendPositions('GUSER');

      expect(position.accruedInterest).toBe('0');
    });

    it('returns an empty list for an unreachable pool', async () => {
      process.env['EXPO_PUBLIC_BLEND_POOL_IDS'] = 'CPOOL1';
      mockPoolV2Load.mockRejectedValue(new Error('rpc down'));
      mockPoolV1Load.mockRejectedValue(new Error('rpc down'));

      await expect(loadBlendPositions('GUSER')).resolves.toEqual([]);
    });
  });
});
