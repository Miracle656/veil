import React from 'react';
import * as Clipboard from 'expo-clipboard';
import { RecentBillOrders } from '../RecentBillOrders';
import type { PersistedBillOrder } from '../../lib/billOrders';

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(async () => true),
}));

jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      accent: '#FFD700',
      surfaceSm: '#111111',
      surfaceMd: '#222222',
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

describe('RecentBillOrders component', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('renders nothing when orders list is empty', () => {
    let tree!: ReturnType<Renderer['create']>;
    renderer.act(() => {
      tree = renderer.create(<RecentBillOrders orders={[]} />);
    });
    expect(tree.toJSON()).toBeNull();
    renderer.act(() => {
      tree.unmount();
    });
  });

  it('renders recent orders with category, identifier, and amounts', () => {
    const orders: PersistedBillOrder[] = [
      {
        orderId: 'ord_airtime_1',
        customerRef: 'veil_ref',
        category: 'airtime',
        provider: 'MTN',
        identifier: '08031234567',
        amount: 1000,
        amountCrypto: 0.67,
        asset: 'usdc',
        status: 'completed',
        time: Date.now(),
      },
    ];

    let tree!: ReturnType<Renderer['create']>;
    renderer.act(() => {
      tree = renderer.create(<RecentBillOrders orders={orders} />);
    });
    const section = tree.root.findByProps({ testID: 'recent-bill-orders-section' });
    expect(section).toBeDefined();

    const orderCard = tree.root.findByProps({ testID: 'bill-order-ord_airtime_1' });
    const content = allText(orderCard);
    expect(content).toContain('MTN');
    expect(content).toContain('AIRTIME');
    expect(content).toContain('08031234567');
    expect(content).toContain('₦1,000');
    expect(content).toContain('0.67 USDC');
    expect(content).toContain('Completed');

    renderer.act(() => {
      tree.unmount();
    });
  });

  it('displays the prepaid token for electricity and copies on press', async () => {
    const orders: PersistedBillOrder[] = [
      {
        orderId: 'ord_elec_token_1',
        customerRef: 'veil_ref',
        category: 'electricity',
        provider: 'IKEDC',
        identifier: '10109998888',
        amount: 5000,
        amountCrypto: 3.33,
        asset: 'usdc',
        status: 'completed',
        time: Date.now(),
        token: '4532-8901-2345-6789-0123',
      },
    ];

    let tree!: ReturnType<Renderer['create']>;
    renderer.act(() => {
      tree = renderer.create(<RecentBillOrders orders={orders} />);
    });

    const tokenCard = tree.root.findByProps({ testID: 'token-card-ord_elec_token_1' });
    expect(tokenCard).toBeDefined();
    expect(allText(tokenCard)).toContain('4532-8901-2345-6789-0123');

    // Press the copy button
    const copyBtn = tokenCard.findByProps({ accessibilityLabel: 'Copy prepaid token' });
    await renderer.act(async () => {
      await (copyBtn.props.onPress as () => Promise<void>)();
    });

    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('4532-8901-2345-6789-0123');

    renderer.act(() => {
      jest.runAllTimers();
      tree.unmount();
    });
  });

  it('triggers onRecheck when the refresh button is pressed', async () => {
    const mockRecheck = jest.fn(async () => {});
    const orders: PersistedBillOrder[] = [
      {
        orderId: 'ord_pending_1',
        customerRef: 'veil_ref',
        category: 'electricity',
        identifier: '10101111111',
        amount: 2000,
        asset: 'usdc',
        status: 'pending',
        time: Date.now(),
      },
    ];

    let tree!: ReturnType<Renderer['create']>;
    renderer.act(() => {
      tree = renderer.create(<RecentBillOrders orders={orders} onRecheck={mockRecheck} />);
    });

    const refreshBtn = tree.root.findByProps({ accessibilityLabel: 'Recheck pending bill orders' });
    await renderer.act(async () => {
      await (refreshBtn.props.onPress as () => Promise<void>)();
    });

    expect(mockRecheck).toHaveBeenCalledTimes(1);

    renderer.act(() => {
      tree.unmount();
    });
  });
});
