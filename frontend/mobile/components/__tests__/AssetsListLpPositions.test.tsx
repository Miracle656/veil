import React from 'react';
import { AssetsList } from '../AssetsList';

const mockLoadHoldings = jest.fn(async () => []);
const mockLoadSoroswapLpPositions = jest.fn();

jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return {
    useFocusEffect: (callback: () => void | (() => void)) => React.useEffect(callback, [callback]),
    useRouter: () => ({ push: jest.fn() }),
  };
});
jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#000000' }) }),
}));
jest.mock('../../hooks/useCurrency', () => ({
  useCurrency: () => ({ format: (amount: number) => `$${amount.toFixed(2)}` }),
}));
jest.mock('../../hooks/useHiddenAmounts', () => ({
  useHiddenAmounts: () => ({ mask: (value: string) => value }),
}));
jest.mock('../TokenIcon', () => ({ TokenIcon: () => null }));
jest.mock('../Skeleton', () => ({ Skeleton: () => null }));
jest.mock('../../lib/holdings', () => ({
  loadHoldings: () => mockLoadHoldings(),
}));
jest.mock('../../lib/soroswapLpPositions', () => ({
  loadSoroswapLpPositions: (address: string) => mockLoadSoroswapLpPositions(address),
}));

type JsonNode = string | { children?: JsonNode[] } | JsonNode[] | null;
type Renderer = {
  act: (fn: () => Promise<void> | void) => Promise<void> | void;
  create: (element: unknown) => { toJSON: () => JsonNode; unmount: () => void };
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer: Renderer = require('react-test-renderer');

function textContent(node: JsonNode): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textContent).join('');
  return node?.children?.map(textContent).join('') ?? '';
}

describe('AssetsList LP positions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadSoroswapLpPositions.mockResolvedValue([
      {
        pairId: 'CPAIR',
        tokenA: 'XLM',
        tokenB: 'USDC',
        lpBalance: '25',
        ownershipPercent: '2.50',
        underlyingA: '125',
        underlyingB: '300',
        usd: 312.5,
      },
    ]);
  });

  it('labels the position and displays its pair, underlying amounts, ownership, and value', async () => {
    let tree!: ReturnType<Renderer['create']>;
    await renderer.act(async () => {
      tree = renderer.create(<AssetsList address="CWALLET" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const text = textContent(tree.toJSON());
    expect(text).toContain('LP Positions');
    expect(text).toContain('LP Position');
    expect(text).toContain('XLM/USDC');
    expect(text).toContain('125 XLM + 300 USDC');
    expect(text).toContain('2.50% of pool');
    expect(text).toContain('$312.50');

    renderer.act(() => tree.unmount());
  });
});
