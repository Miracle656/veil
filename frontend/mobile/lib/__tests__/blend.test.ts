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
  // A SAC id stub: 'CXLM' for native, 'CUSDC' for USDC, whatever the issuer.
  Asset: class {
    code: string;
    constructor(code: string) {
      this.code = code;
    }
    static native() {
      return { contractId: () => 'CXLM' };
    }
    contractId() {
      return `C${this.code}`;
    }
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

jest.mock('../receiveReadiness', () => ({ usdcIssuerFor: () => 'GISSUER' }));

const mockPoolV2Load = jest.fn();
const mockPoolV1Load = jest.fn();

jest.mock('@blend-capital/blend-sdk', () => ({
  PoolV2: { load: (...args: unknown[]) => mockPoolV2Load(...args) },
  PoolV1: { load: (...args: unknown[]) => mockPoolV1Load(...args) },
  PoolContractV1: class {},
  PoolContractV2: class {},
  RequestType: { Supply: 2, Withdraw: 3 },
}));

import { loadBlendPools, loadBlendPositions, withdrawAllAmount } from '../blend';

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

    it("keeps each reserve's own APY rather than averaging them", async () => {
      process.env['EXPO_PUBLIC_BLEND_POOL_IDS'] = 'CPOOL1';
      mockPoolV2Load.mockResolvedValue(
        poolStub({
          id: 'CPOOL1',
          name: 'Fixed',
          reserves: [
            { assetId: 'CXLM', supply: 500n, apy: 0.002 },
            { assetId: 'CUSDC', supply: 1_000n, apy: 0.09 },
          ],
        })
      );

      const [pool] = await loadBlendPools();

      expect(pool).toEqual({
        id: 'CPOOL1',
        name: 'Fixed',
        reserves: [
          { assetId: 'CXLM', code: 'XLM', supplyApy: 0.002, totalSupply: '500' },
          { assetId: 'CUSDC', code: 'USDC', supplyApy: 0.09, totalSupply: '1000' },
        ],
      });
    });

    it('leaves out reserves the wallet cannot fund', async () => {
      process.env['EXPO_PUBLIC_BLEND_POOL_IDS'] = 'CPOOL1';
      mockPoolV2Load.mockResolvedValue(
        poolStub({
          id: 'CPOOL1',
          reserves: [
            { assetId: 'CEURC', supply: 9n, apy: 0.05 },
            { assetId: 'CUSDC', supply: 1n, apy: 0.09 },
          ],
        })
      );

      const [pool] = await loadBlendPools();

      expect(pool.reserves.map((r) => r.code)).toEqual(['USDC']);
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
      expect(pool.reserves[0].totalSupply).toBe('7');
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

    it('reports a zero APY instead of NaN', async () => {
      process.env['EXPO_PUBLIC_BLEND_POOL_IDS'] = 'CPOOL1';
      mockPoolV2Load.mockResolvedValue(
        poolStub({ id: 'CPOOL1', reserves: [{ assetId: 'CXLM', supply: 0n, apy: Number.NaN }] })
      );

      const [pool] = await loadBlendPools();

      expect(pool.reserves[0].supplyApy).toBe(0);
    });
  });

  describe('loadBlendPositions', () => {
    it('keeps only reserves the user actually supplied, valued in the underlying asset', async () => {
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
          code: 'USDC',
          deposited: '130',
          bTokenBalance: '100',
        },
      ]);
    });

    it('returns an empty list for an unreachable pool', async () => {
      process.env['EXPO_PUBLIC_BLEND_POOL_IDS'] = 'CPOOL1';
      mockPoolV2Load.mockRejectedValue(new Error('rpc down'));
      mockPoolV1Load.mockRejectedValue(new Error('rpc down'));

      await expect(loadBlendPositions('GUSER')).resolves.toEqual([]);
    });
  });

  describe('withdrawAllAmount', () => {
    it('asks for more than the position, so interest accrued since the read is included', () => {
      expect(withdrawAllAmount(1_000_000_000n)).toBe(1_100_000_001n);
    });

    it('is never zero', () => {
      expect(withdrawAllAmount(0n)).toBe(1n);
    });
  });
});
