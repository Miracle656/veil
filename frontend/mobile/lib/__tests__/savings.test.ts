/**
 * Savings logic tests: aggregation per asset, reserve choice, exact money
 * formatting and parsing, and the earned-to-date ledger.
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  let store: Record<string, string> = {};
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (key: string) => (key in store ? store[key] : null)),
      setItem: jest.fn(async (key: string, value: string) => {
        store[key] = value;
      }),
      __reset: () => {
        store = {};
      },
    },
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { BlendPool, BlendPosition } from '../blend';
import {
  earnedStroops,
  formatStroops,
  isPoolFullError,
  loadLedger,
  parseAmountToStroops,
  pickReserve,
  poolsHolding,
  principalKey,
  recordAdded,
  recordTakenOut,
  reconcileLedger,
  savingsBalances,
  syncPrincipal,
} from '../savings';

const reset = () => (AsyncStorage as unknown as { __reset: () => void }).__reset();

function position(poolId: string, code: BlendPosition['code'], deposited: string): BlendPosition {
  return { poolId, asset: `C${code}`, code, deposited, bTokenBalance: deposited };
}

function pool(id: string, name: string, reserves: [ 'USDC' | 'XLM', number ][]): BlendPool {
  return {
    id,
    name,
    reserves: reserves.map(([code, supplyApy]) => ({ assetId: `C${code}`, code, supplyApy, totalSupply: '0' })),
  };
}

beforeEach(() => reset());

describe('savingsBalances', () => {
  it('shows one balance per asset, not one per pool', () => {
    const balances = savingsBalances([
      position('P1', 'USDC', '50000000'),
      position('P2', 'USDC', '25000000'),
      position('P1', 'XLM', '10000000'),
    ]);
    expect(balances.map((b) => [b.code, b.valueStroops])).toEqual([
      ['USDC', 75000000n],
      ['XLM', 10000000n],
    ]);
    expect(balances.find((b) => b.code === 'USDC')?.positions).toHaveLength(2);
  });

  it('leaves out assets the wallet cannot fund and empty positions', () => {
    expect(savingsBalances([position('P1', null, '5'), position('P1', 'USDC', '0')])).toEqual([]);
  });
});

describe('pickReserve / poolsHolding', () => {
  const pools = [pool('P1', 'Fixed', [['USDC', 0.03], ['XLM', 0.01]]), pool('P2', 'Other', [['USDC', 0.05]])];

  it('picks the best-paying reserve for the asset without the user choosing', () => {
    expect(pickReserve(pools, 'USDC')?.pool.id).toBe('P2');
    expect(pickReserve(pools, 'XLM')?.pool.id).toBe('P1');
  });

  it('returns null when no pool takes the asset', () => {
    expect(pickReserve([pool('P1', 'Fixed', [['XLM', 0.01]])], 'USDC')).toBeNull();
  });

  it('names the pools that hold an asset', () => {
    const [usdc] = savingsBalances([position('P1', 'USDC', '1'), position('P2', 'USDC', '1')]);
    expect(poolsHolding(usdc, pools)).toEqual(['Fixed', 'Other']);
    expect(poolsHolding({ ...usdc, positions: [position('PXXXXXXXX', 'USDC', '1')] }, pools)).toEqual(['PXXXXX…']);
  });
});

describe('formatStroops', () => {
  it('truncates instead of rounding, so a balance never overstates', () => {
    expect(formatStroops(19999999n, 2)).toBe('1.99');
    expect(formatStroops(0n, 2)).toBe('0.00');
  });

  it('shows the small earned figure with enough places to move', () => {
    expect(formatStroops(1234n, 6)).toBe('0.000123');
    expect(formatStroops(12345678n, 6)).toBe('1.234567');
  });

  it('groups thousands', () => {
    expect(formatStroops(12345678900000n, 2)).toBe('1,234,567.89');
  });
});

describe('parseAmountToStroops', () => {
  it('parses exact amounts', () => {
    expect(parseAmountToStroops('1')).toBe(10000000n);
    expect(parseAmountToStroops('0.1234567')).toBe(1234567n);
    expect(parseAmountToStroops(' 12.5 ')).toBe(125000000n);
  });

  it('rejects zero, negatives, junk and more than 7 decimals', () => {
    for (const bad of ['', '0', '0.0', '-1', '1e3', 'abc', '1.', '.5', '1.12345678']) {
      expect(parseAmountToStroops(bad)).toBeNull();
    }
  });
});

describe('earnedStroops', () => {
  it('is value minus principal, and a loss stays negative', () => {
    expect(earnedStroops(1050n, 1000n)).toBe(50n);
    expect(earnedStroops(999n, 1000n)).toBe(-1n);
    expect(formatStroops(earnedStroops(999n, 1000n), 6)).toBe('-0.000000');
    expect(formatStroops(earnedStroops(9_000_000n, 10_000_000n), 6)).toBe('-0.100000');
  });
});

describe('isPoolFullError', () => {
  it('matches a full pool', () => {
    expect(isPoolFullError('Pool utilization too high')).toBe(true);
    expect(isPoolFullError('Supply cap reached')).toBe(true);
    expect(isPoolFullError('amount exceeds the cap')).toBe(true);
  });
  it('does not match unrelated errors that merely contain "cap"', () => {
    expect(isPoolFullError('Cannot reach the network')).toBe(false);
    expect(isPoolFullError('Signing key not found')).toBe(false);
    expect(isPoolFullError('capability not supported')).toBe(false);
    expect(isPoolFullError('Escape sequence invalid')).toBe(false);
  });
});

describe('principal ledger', () => {
  const usdcKey = principalKey('mainnet', 'GABC', 'USDC');

  it('baselines a position it has never seen at its current value', async () => {
    const balances = savingsBalances([position('P1', 'USDC', '5000')]);
    const principal = await syncPrincipal('mainnet', 'GABC', balances, ['USDC', 'XLM']);
    expect(principal.get('USDC')).toBe(5000n);
    expect((await loadLedger())[usdcKey]).toBe('5000');
  });

  it('keeps the recorded principal, so growth shows as earned', async () => {
    await recordAdded('mainnet', 'GABC', 'USDC', 0n, 5000n);
    const grown = savingsBalances([position('P1', 'USDC', '5007')]);
    const principal = await syncPrincipal('mainnet', 'GABC', grown, ['USDC', 'XLM']);
    expect(earnedStroops(grown[0].valueStroops, principal.get('USDC')!)).toBe(7n);
  });

  it('adds to the existing principal, or to the pre-deposit value when none is recorded', async () => {
    await recordAdded('mainnet', 'GABC', 'USDC', 1000n, 500n);
    expect((await loadLedger())[usdcKey]).toBe('1500');
    await recordAdded('mainnet', 'GABC', 'USDC', 9999n, 500n);
    expect((await loadLedger())[usdcKey]).toBe('2000');
  });

  it('clears the record when an asset is taken out, and when it reads empty', async () => {
    await recordAdded('mainnet', 'GABC', 'USDC', 0n, 5000n);
    await recordTakenOut('mainnet', 'GABC', 'USDC');
    expect(await loadLedger()).toEqual({});

    const stale = { [usdcKey]: '5000' };
    const result = reconcileLedger(stale, [], (c) => principalKey('mainnet', 'GABC', c), ['USDC', 'XLM']);
    expect(result.ledger).toEqual({});
    expect(result.changed).toBe(true);
  });

  it('keeps networks and accounts apart', async () => {
    await recordAdded('testnet', 'GABC', 'USDC', 0n, 1n);
    await recordAdded('mainnet', 'GOTHER', 'USDC', 0n, 2n);
    const ledger = await loadLedger();
    expect(ledger[principalKey('testnet', 'GABC', 'USDC')]).toBe('1');
    expect(ledger[principalKey('mainnet', 'GOTHER', 'USDC')]).toBe('2');
    expect(ledger[usdcKey]).toBeUndefined();
  });

  it('ignores a corrupt stored ledger', async () => {
    await AsyncStorage.setItem('veil_savings_principal_v1', '{"a":"12","b":5,"c":"x"}');
    expect(await loadLedger()).toEqual({ a: '12' });
    await AsyncStorage.setItem('veil_savings_principal_v1', 'not json');
    expect(await loadLedger()).toEqual({});
  });
});
