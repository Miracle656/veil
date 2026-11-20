/**
 * Blend backstop tests.
 *
 * The Blend SDK and the Stellar SDK are mocked. What matters here: the value
 * reported is the CURRENT one (a share can be worth less than what was put in),
 * emissions stay a separate figure, a pool that fails to load is reported rather
 * than dropped, and each of the four transactions calls the right contract
 * method with the right unit (tokens to deposit, shares for everything else).
 */

jest.mock('@stellar/stellar-sdk', () => ({
  Account: class {},
  Address: class {
    toScVal() {
      return {};
    }
  },
  BASE_FEE: '100',
  Asset: class {
    static native() {
      return { contractId: () => 'CXLM' };
    }
    contractId() {
      return 'CUSDC';
    }
  },
  Contract: class {
    call() {
      return {};
    }
  },
  scValToNative: (v: unknown) => v,
  TransactionBuilder: class {
    addOperation() {
      return this;
    }
    setTimeout() {
      return this;
    }
    build() {
      return {};
    }
  },
  xdr: { Operation: { fromXDR: (op: string) => ({ op }) } },
  rpc: {
    Server: class {
      getAccount = async (address: string) => ({
        accountId: () => address,
        sequenceNumber: () => '1',
      });
      simulateTransaction = async () => ({});
    },
    Api: { isSimulationError: () => false },
    assembleTransaction: () => ({ build: () => ({ toXDR: () => 'ASSEMBLED_XDR' }) }),
  },
}));

jest.mock('../receiveReadiness', () => ({ usdcIssuerFor: () => 'GISSUER' }));
jest.mock('../network', () => ({
  getNetwork: () => ({
    name: 'testnet',
    rpcUrl: 'https://rpc.test',
    networkPassphrase: 'Test SDF Network ; September 2015',
  }),
}));

const mockPoolV2Load = jest.fn();
const mockBackstopLoad = jest.fn();
const mockBackstopPoolV2Load = jest.fn();
const mockBackstopPoolV1Load = jest.fn();
const mockUserLoad = jest.fn();
const mockEstBuild = jest.fn();
const mockV2Calls: { method: string; args: unknown }[] = [];
let mockV2Throws = false;

jest.mock('@blend-capital/blend-sdk', () => {
  const recorder = (method: string) =>
    function (this: unknown, args: unknown) {
      if (mockV2Throws) throw new Error('not a v2 backstop');
      mockV2Calls.push({ method, args });
      return `OP:${method}`;
    };
  class BackstopContractV2 {
    deposit = recorder('deposit');
    queueWithdrawal = recorder('queueWithdrawal');
    dequeueWithdrawal = recorder('dequeueWithdrawal');
    withdraw = recorder('withdraw');
  }
  class BackstopContractV1 {
    deposit = (args: unknown) => {
      mockV2Calls.push({ method: 'v1.deposit', args });
      return 'OP:v1.deposit';
    };
    queueWithdrawal = () => 'OP:v1.queue';
    dequeueWithdrawal = () => 'OP:v1.dequeue';
    withdraw = () => 'OP:v1.withdraw';
  }
  return {
    PoolV2: { load: (...a: unknown[]) => mockPoolV2Load(...a) },
    PoolV1: { load: jest.fn() },
    PoolContractV1: class {},
    PoolContractV2: class {},
    RequestType: { Supply: 2, Withdraw: 3 },
    Backstop: { load: (...a: unknown[]) => mockBackstopLoad(...a) },
    BackstopPoolV2: { load: (...a: unknown[]) => mockBackstopPoolV2Load(...a) },
    BackstopPoolV1: { load: (...a: unknown[]) => mockBackstopPoolV1Load(...a) },
    BackstopPoolUser: { load: (...a: unknown[]) => mockUserLoad(...a) },
    BackstopPoolUserEst: { build: (...a: unknown[]) => mockEstBuild(...a) },
    BackstopContractV1,
    BackstopContractV2,
  };
});

import {
  backstopSharePrice,
  buildBackstopActionXdr,
  loadBackstopOverview,
  parseStroops,
} from '../blend';

const USER = 'GUSER';
const POOL = 'CPOOL1';
const BACKSTOP = 'CBACKSTOP';
const LP = 'CLPTOKEN';
const E7 = 10_000_000n;

/** A backstop pool holding `tokens` for `shares`, queued `q4w`. Value = shares × tokens / shares_total. */
function backstopPool(shares: bigint, tokens: bigint, q4w = 0n) {
  return {
    poolBalance: { shares, tokens, q4w },
    emissions: undefined,
    sharesToBackstopTokens: (s: bigint) => (shares === 0n ? s : (s * tokens) / shares),
  };
}

function userBalance(opts: { shares: bigint; q4w?: { amount: bigint; exp: bigint }[]; unlocked?: bigint }) {
  const q4w = opts.q4w ?? [];
  const unlocked = opts.unlocked ?? 0n;
  return {
    balance: {
      shares: opts.shares,
      q4w,
      unlockedQ4W: unlocked,
      totalQ4W: q4w.reduce((s, q) => s + q.amount, 0n) + unlocked,
    },
    emissions: undefined,
  };
}

function setup(pool: ReturnType<typeof backstopPool>, user: ReturnType<typeof userBalance>, blnd = 0) {
  process.env['EXPO_PUBLIC_BLEND_POOL_IDS_TESTNET'] = POOL;
  mockPoolV2Load.mockResolvedValue({ id: POOL, metadata: { name: 'Fixed', backstop: BACKSTOP } });
  mockBackstopLoad.mockResolvedValue({
    config: { backstopTkn: LP },
    backstopToken: { lpTokenPrice: 2 },
  });
  mockBackstopPoolV2Load.mockResolvedValue(pool);
  mockUserLoad.mockResolvedValue(user);
  mockEstBuild.mockReturnValue({ emissions: blnd });
}

describe('backstop', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockV2Calls.length = 0;
    mockV2Throws = false;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env['EXPO_PUBLIC_BLEND_POOL_IDS_TESTNET'];
  });

  describe('loadBackstopOverview: the value shown is the current one', () => {
    it('reports a share worth LESS than the deposit when the backstop has been drawn', async () => {
      // 100 shares were issued for 100 tokens at par. A draw left the backstop
      // with 900 tokens against 1000 shares, so they are now worth 90.
      setup(backstopPool(1000n * E7, 900n * E7), userBalance({ shares: 100n * E7 }));

      const { positions } = await loadBackstopOverview(USER);

      expect(positions).toHaveLength(1);
      const [position] = positions;
      expect(position.lpTokens).toBe((90n * E7).toString());
      expect(BigInt(position.lpTokens)).toBeLessThan(100n * E7);
      expect(position.sharePrice).toBeCloseTo(0.9, 10);
      // 90 LP at the 2 USDC spot price the mock reports.
      expect(position.usdValue).toBeCloseTo(180, 6);
    });

    it('reports a share worth MORE than par after the pool has paid interest', async () => {
      setup(backstopPool(1000n * E7, 1100n * E7), userBalance({ shares: 100n * E7 }));

      const [position] = (await loadBackstopOverview(USER)).positions;

      expect(position.lpTokens).toBe((110n * E7).toString());
      expect(position.sharePrice).toBeCloseTo(1.1, 10);
    });

    it('values queued and unlocked shares too, because they still carry the loss', async () => {
      setup(
        backstopPool(1000n * E7, 900n * E7),
        userBalance({
          shares: 50n * E7,
          q4w: [{ amount: 30n * E7, exp: 2_000_000_000n }],
          unlocked: 20n * E7,
        }),
      );

      const [position] = (await loadBackstopOverview(USER)).positions;

      expect(position.activeShares).toBe((50n * E7).toString());
      expect(position.queued).toEqual([
        { shares: (30n * E7).toString(), lpTokens: (27n * E7).toString(), expiresAt: 2_000_000_000 },
      ]);
      expect(position.unlockedShares).toBe((20n * E7).toString());
      // 100 shares in all, at 0.9 each.
      expect(position.lpTokens).toBe((90n * E7).toString());
    });

    it('keeps emissions as their own figure, outside the position value', async () => {
      setup(backstopPool(1000n * E7, 1000n * E7), userBalance({ shares: 100n * E7 }), 12.5);

      const [position] = (await loadBackstopOverview(USER)).positions;

      expect(position.emissionsBlnd).toBe(12.5);
      // The position is the 100 tokens; the 12.5 BLND is not folded into it.
      expect(position.lpTokens).toBe((100n * E7).toString());
    });

    it('lists the pool with no position when the wallet holds no shares', async () => {
      setup(backstopPool(1000n * E7, 1000n * E7, 100n * E7), userBalance({ shares: 0n }));

      const overview = await loadBackstopOverview(USER);

      expect(overview.positions).toEqual([]);
      expect(overview.pools).toEqual([
        {
          poolId: POOL,
          poolName: 'Fixed',
          backstopId: BACKSTOP,
          lpToken: LP,
          sharePrice: 1,
          queuedFraction: 0.1,
        },
      ]);
    });

    it('reads the backstop token from the backstop config, not a constant', async () => {
      setup(backstopPool(1n * E7, 1n * E7), userBalance({ shares: 0n }));

      const [pool] = (await loadBackstopOverview(USER)).pools;

      expect(pool.lpToken).toBe(LP);
    });

    it('reports a pool that failed to load instead of silently showing no position', async () => {
      setup(backstopPool(1n * E7, 1n * E7), userBalance({ shares: 0n }));
      mockUserLoad.mockRejectedValue(new Error('rpc down'));

      const overview = await loadBackstopOverview(USER);

      expect(overview.positions).toEqual([]);
      expect(overview.failedPoolIds).toEqual([POOL]);
    });
  });

  describe('backstopSharePrice', () => {
    it('is 1 for an empty backstop and tokens per share otherwise', () => {
      expect(backstopSharePrice({ shares: 0n, tokens: 0n })).toBe(1);
      expect(backstopSharePrice({ shares: 1000n * E7, tokens: 800n * E7 })).toBeCloseTo(0.8, 10);
    });
  });

  describe('parseStroops', () => {
    it('parses decimals exactly, without floats', () => {
      expect(parseStroops('1')).toBe(E7);
      expect(parseStroops('0.0000001')).toBe(1n);
      expect(parseStroops(' 12.3456789 ')).toBe(123_456_789n);
      // A float parse would turn this into 1.0000000000000002 × 1e7.
      expect(parseStroops('0.1000001')).toBe(1_000_001n);
    });

    it('rejects zero, negatives, junk and more than 7 decimals', () => {
      for (const bad of ['', '0', '0.0', '-1', 'abc', '1e3', '1.', '.5', '0.12345678', '1,5']) {
        expect(parseStroops(bad)).toBeNull();
      }
    });
  });

  describe('buildBackstopActionXdr', () => {
    const base = { backstopId: BACKSTOP, poolId: POOL, userAddress: USER };

    it.each([
      ['deposit', 'deposit'],
      ['queue', 'queueWithdrawal'],
      ['cancel', 'dequeueWithdrawal'],
      ['withdraw', 'withdraw'],
    ] as const)('%s calls %s with the pool, the user and the amount', async (action, method) => {
      const xdr = await buildBackstopActionXdr({ ...base, action, amount: 5n * E7 });

      expect(xdr).toBe('ASSEMBLED_XDR');
      expect(mockV2Calls).toEqual([
        { method, args: { from: USER, pool_address: POOL, amount: 5n * E7 } },
      ]);
    });

    it('refuses a zero or negative amount before touching the network', async () => {
      await expect(buildBackstopActionXdr({ ...base, action: 'queue', amount: 0n })).rejects.toThrow(/above zero/);
      await expect(buildBackstopActionXdr({ ...base, action: 'queue', amount: -1n })).rejects.toThrow(/above zero/);
      expect(mockV2Calls).toEqual([]);
    });

    it('falls back to the v1 backstop contract when v2 cannot encode the call', async () => {
      mockV2Throws = true;

      await buildBackstopActionXdr({ ...base, action: 'deposit', amount: E7 });

      expect(mockV2Calls).toEqual([
        { method: 'v1.deposit', args: { from: USER, pool_address: POOL, amount: E7 } },
      ]);
    });
  });
});
