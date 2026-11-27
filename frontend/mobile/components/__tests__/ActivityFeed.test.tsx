import React from 'react';
import type { TxRecord } from '../../lib/activityFeed';
import {
  rememberDepositAddress,
  subscribeDepositAddresses,
  knownDepositAddresses,
  OFFRAMP_DEPOSIT_ADDRESSES_KEY,
} from '../../lib/offramp';
import ActivityFeed from '../ActivityFeed';

const store: Record<string, string> = {};

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (k: string) => store[k] ?? null),
  setItem: jest.fn(async (k: string, v: string) => {
    store[k] = v;
  }),
  removeItem: jest.fn(async (k: string) => {
    delete store[k];
  }),
}));

let mockTransactions: TxRecord[] = [];
jest.mock('../../lib/activityFeed', () => ({
  useActivityFeed: () => mockTransactions,
}));

jest.mock('../StellarIdenticon', () => ({
  StellarIdenticon: () => null,
}));

jest.mock('../../hooks/useReverseName', () => ({
  useReverseName: () => ({ name: null, loading: false }),
}));

jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      accent: '#FFD700',
      surfaceSm: '#111111',
      surfaceMd: '#222222',
      surfaceRaised: '#2A2A2A',
      borderDim: '#333333',
      borderMedium: '#444444',
      textPrimary: '#FFFFFF',
      textSecondary: '#AAAAAA',
      textMuted: '#666666',
      success: '#00D092',
      error: '#FF4D4D',
    },
  }),
}));

type Instance = {
  props: Record<string, unknown>;
  children: (Instance | string)[];
};

type Renderer = {
  act: (fn: () => Promise<void> | void) => Promise<void> | void;
  create: (el: unknown) => {
    root: {
      findByProps: (p: object) => Instance;
      findAllByProps: (p: object) => Instance[];
    };
    toJSON: () => unknown;
    unmount: () => void;
  };
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer: Renderer = require('react-test-renderer');

function allText(node: Instance): string {
  return (node.children || [])
    .map((c) => (typeof c === 'string' ? c : allText(c)))
    .join('');
}

describe('ActivityFeed live deposit address updates', () => {
  const TEST_DESTINATION = 'GBAUTO11111111111111111111111111111111111111111111111111TEST';

  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    mockTransactions = [
      {
        id: 'tx_cashout_test_1',
        type: 'sent',
        amount: '50',
        asset: 'USDC',
        counterparty: TEST_DESTINATION,
        timestamp: Math.floor(Date.now() / 1000),
      },
    ];
  });

  it('updates a sent transaction to "Cashed out" without remounting when the address is remembered', async () => {
    let tree!: ReturnType<Renderer['create']>;

    await renderer.act(async () => {
      tree = renderer.create(<ActivityFeed />);
    });

    // Initially, destination is unknown, so the transaction is rendered as "Sent"
    const rowButton = tree.root.findByProps({ accessibilityRole: 'button' });
    expect(allText(rowButton)).toContain('↑ Sent');
    expect(rowButton.props.accessibilityLabel).toContain('Sent 50 USDC');

    // Remember the deposit address (simulating cash-out payment completion in another screen)
    await renderer.act(async () => {
      await rememberDepositAddress(TEST_DESTINATION);
    });

    // Without remounting, the subscription updates the row to "Cashed out"
    const updatedRowButton = tree.root.findByProps({ accessibilityRole: 'button' });
    expect(allText(updatedRowButton)).toContain('🏦 Cashed out');
    expect(updatedRowButton.props.accessibilityLabel).toContain('Cashed out 50 USDC');

    renderer.act(() => {
      tree.unmount();
    });
  });

  it('unsubscribes on unmount and prevents state updates after teardown', async () => {
    let tree!: ReturnType<Renderer['create']>;

    await renderer.act(async () => {
      tree = renderer.create(<ActivityFeed />);
    });

    renderer.act(() => {
      tree.unmount();
    });

    // Remembering an address after unmount should not throw or cause unmounted errors
    await expect(rememberDepositAddress('GBUNMOUNTED111111111111111111111111111111111111111111TEST')).resolves.not.toThrow();
  });
});
