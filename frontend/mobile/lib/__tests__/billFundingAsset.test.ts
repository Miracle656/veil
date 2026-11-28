jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {};
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (k: string) => store[k] ?? null),
      setItem: jest.fn(async (k: string, v: string) => {
        store[k] = v;
      }),
    },
  };
});

import { decideFundingAsset, loadFundingChoice, saveFundingChoice } from '../billFundingAsset';

const costs = { xlm: 10, usdc: 2 };

describe('decideFundingAsset', () => {
  it('both affordable: user can choose, default is explained', () => {
    const d = decideFundingAsset({ costs, holdings: { xlm: 50, usdc: 5 }, preferred: null });
    expect(d.status).toBe('both');
    expect(d.canChoose).toBe(true);
    expect(d.coin).toBe('usdc');
    expect(d.reason).toMatch(/Choose/);
  });

  it('both affordable: honours a remembered choice', () => {
    const d = decideFundingAsset({ costs, holdings: { xlm: 50, usdc: 5 }, preferred: 'xlm' });
    expect(d.coin).toBe('xlm');
    expect(d.automatic).toBe(false);
    expect(d.canChoose).toBe(true);
  });

  it('only USDC affordable: picks it and says why XLM was not used', () => {
    const d = decideFundingAsset({ costs, holdings: { xlm: 9.99, usdc: 5 }, preferred: 'xlm' });
    expect(d.status).toBe('only-one');
    expect(d.coin).toBe('usdc');
    expect(d.canChoose).toBe(false);
    expect(d.automatic).toBe(true);
    expect(d.reason).toBe('Paid with USDC because your spendable XLM is short (the account reserve is held back).');
  });

  it('only XLM affordable: picks it and says USDC is short', () => {
    const d = decideFundingAsset({ costs, holdings: { xlm: 50, usdc: 1 }, preferred: 'usdc' });
    expect(d.coin).toBe('xlm');
    expect(d.reason).toBe('Paid with XLM because your USDC balance is short.');
  });

  it('neither affordable: no asset, says so', () => {
    const d = decideFundingAsset({ costs, holdings: { xlm: 1, usdc: 1 }, preferred: null });
    expect(d.status).toBe('neither');
    expect(d.coin).toBeNull();
    expect(d.reason).toMatch(/Neither/);
  });

  it('reserve-aware XLM: a raw balance that looks enough is not', () => {
    const spendable = 10.5 - 1.5;
    const d = decideFundingAsset({ costs, holdings: { xlm: spendable, usdc: 0 }, preferred: null });
    expect(d.status).toBe('neither');
  });

  it('unknown while balances or rates are not loaded', () => {
    expect(decideFundingAsset({ costs, holdings: null, preferred: 'xlm' }).status).toBe('unknown');
    expect(
      decideFundingAsset({ costs: { xlm: null, usdc: null }, holdings: { xlm: 1, usdc: 1 }, preferred: null }).status,
    ).toBe('unknown');
  });
});

describe('funding choice persistence', () => {
  it('remembers the choice', async () => {
    expect(await loadFundingChoice()).toBeNull();
    await saveFundingChoice('xlm');
    expect(await loadFundingChoice()).toBe('xlm');
  });
});
