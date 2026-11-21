/**
 * Flow-level tests for the airtime screen (#1141).
 *
 * The unit-level pieces — status classification, the poller, fee preview — each
 * have tests. What is exercised here is the path the person actually walks:
 * enter, preview the charge, confirm, spend, poll, land somewhere terminal.
 *
 * Every provider and spend call is mocked. Linq has no sandbox and every real
 * call moves money, so nothing below can reach it: `payBill`, `getBillStatus`,
 * `spendAsset` and `previewSpendFee` are all replaced at the module boundary.
 *
 * The assertions are on what the person is told, because that is what decides
 * whether they pay twice. A spend that succeeds while the poll times out must
 * not be described as a failure; a spend that never happened must not leave an
 * order polling forever.
 *
 * Addresses are full 56-character `G…` fixtures rather than placeholders: a
 * shortened address in a fixture is how contributors end up inventing one.
 */

import React from 'react';

import { NotEnoughToSend } from '../lib/spendAsset';

/** Fee-payer account: the classic wallet bills are refunded to. */
const REFUND_ADDRESS = 'GAGRKGE7T3J4BNTO5G7F2KOEJIKNYY4SK2QHZUD6HAF7C4DQHAUM7U27';

/** The deposit wallet `payBill` returns, which is where the crypto is sent. */
const LINQ_DEPOSIT_WALLET = 'GCCY3DVGYKNGBYNXVPVIQ6OGDXJN6VWNAKBDX4SLQIRHBEC3O2SU6R2Q';

/** Where a platform fee would be collected. */
const FEE_DESTINATION = 'GCDPRN5URKLVHTRRJZGFYHLMXXCZZWWVPT5QRHMCPKHNHB6SPFUZWFJ2';

const CUSTOMER_REF = 'veil_airtime_customer_123';
const PHONE = '08031234567';
const RATE = 1450;
/** ₦500 at ₦1,450 per USDC, at the 7 decimals both `payBill` and `spendAsset` use. */
const LOCKED_COST = 0.3448276;

// Mocks

const mockPush = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack }),
}));

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(async () => true),
}));

jest.mock('../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      background: '#0a0a0a',
      surface: '#171717',
      surfaceRaised: '#222222',
      border: '#333333',
      textStrong: '#ffffff',
      textPrimary: '#eeeeee',
      textSecondary: '#aaaaaa',
      textMuted: '#666666',
      accent: '#f59e0b',
      onAccent: '#000000',
      danger: '#ef4444',
      dangerSurface: 'rgba(239, 68, 68, 0.1)',
      positive: '#10b981',
    },
  }),
}));

const mockNetworkName = { current: 'mainnet' };
jest.mock('../hooks/useNetwork', () => ({
  useNetwork: () => ({ networkName: mockNetworkName.current }),
}));

const mockDeploy = jest.fn();
jest.mock('../components/WalletProvider', () => ({
  useWallet: () => ({
    wallet: { address: 'C_SMART_WALLET', deploy: mockDeploy },
  }),
}));

const mockSpendAsset = jest.fn();
const mockPreviewSpendFee = jest.fn();
jest.mock('../lib/spendAsset', () => {
  const actual = jest.requireActual('../lib/spendAsset');
  return {
    ...actual,
    spendAsset: (...args: unknown[]) => mockSpendAsset(...args),
    previewSpendFee: (...args: unknown[]) => mockPreviewSpendFee(...args),
  };
});

const mockPayBill = jest.fn();
const mockGetBillStatus = jest.fn();
const mockGetOnrampRate = jest.fn();
const mockIsNairaVerified = jest.fn();
const mockGetCustomerRef = jest.fn();
jest.mock('../lib/onramp', () => {
  const actual = jest.requireActual('../lib/onramp');
  return {
    ...actual,
    payBill: (...args: unknown[]) => mockPayBill(...args),
    getBillStatus: (...args: unknown[]) => mockGetBillStatus(...args),
    getOnrampRate: (...args: unknown[]) => mockGetOnrampRate(...args),
    isNairaVerified: (...args: unknown[]) => mockIsNairaVerified(...args),
    getCustomerRef: (...args: unknown[]) => mockGetCustomerRef(...args),
  };
});

const mockGetFeePayerAddress = jest.fn();
jest.mock('../lib/activity', () => ({
  getFeePayerAddress: () => mockGetFeePayerAddress(),
}));

const mockSaveBillOrder = jest.fn();
const mockGetBillOrders = jest.fn();
jest.mock('../lib/billOrders', () => {
  const actual = jest.requireActual('../lib/billOrders');
  return {
    ...actual,
    saveBillOrder: (...args: unknown[]) => mockSaveBillOrder(...args),
    getBillOrders: (...args: unknown[]) => mockGetBillOrders(...args),
  };
});

jest.mock('../components/SlideToConfirm', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require('react');
  return {
    SlideToConfirm: (props: { label: string; onConfirm: () => void }) => {
      return ReactLib.createElement('SlideToConfirm', props);
    },
  };
});

jest.mock('../components/FlowHeader', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require('react');
  return {
    FlowHeader: (props: { title: string }) => {
      return ReactLib.createElement('FlowHeader', props);
    },
  };
});

// Imported after the mocks so the screen resolves the mocked modules.
// eslint-disable-next-line import/first
import AirtimeScreen from '../app/airtime';

type Instance = {
  props: Record<string, any>;
  children: (Instance | string)[];
};
type Renderer = {
  act: (fn: () => Promise<void>) => Promise<void>;
  create: (el: unknown) => {
    root: Instance & {
      findByProps: (p: object) => Instance;
      findAllByProps: (p: object) => Instance[];
      findByType: (type: unknown) => Instance;
      findAllByType: (type: unknown) => Instance[];
    };
  };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer: Renderer = require('react-test-renderer');

function getAllText(node: Instance | string): string {
  const texts: string[] = [];
  const walk = (n: Instance | string) => {
    if (typeof n === 'string') {
      texts.push(n);
      return;
    }
    if (n && n.children && Array.isArray(n.children)) {
      n.children.forEach(walk);
    }
  };
  walk(node);
  // React renders each interpolated value as its own text node, so collapse
  // the seams to compare the copy as the person reads it.
  return texts.join(' ').replace(/\s+/g, ' ').trim();
}

async function flush() {
  await renderer.act(async () => {});
}

async function renderScreen() {
  let tree!: ReturnType<Renderer['create']>;
  await renderer.act(async () => {
    tree = renderer.create(React.createElement(AirtimeScreen));
  });
  return tree.root;
}

/** Fill the form and move to the confirm step, where the fee is previewed. */
async function enterForm(root: ReturnType<typeof renderScreen> extends Promise<infer R> ? R : never) {
  await renderer.act(async () => {
    root.findByProps({ testID: 'airtime-phone-input' }).props.onChangeText?.(PHONE);
  });
  await renderer.act(async () => {
    root.findByProps({ testID: 'airtime-amount-input' }).props.onChangeText?.('500');
  });
  await renderer.act(async () => {
    root.findByProps({ testID: 'airtime-continue-btn' }).props.onPress?.();
  });
  await flush();
}

async function slideToPay(root: ReturnType<typeof renderScreen> extends Promise<infer R> ? R : never) {
  const slider = root.findByType('SlideToConfirm');
  await renderer.act(async () => {
    slider.props.onConfirm();
  });
  await flush();
}

function orderResponse() {
  return {
    id: 'ord_airtime_500_abc123',
    customerRef: CUSTOMER_REF,
    wallet: LINQ_DEPOSIT_WALLET,
    status: 'initiated',
  };
}

function statusResponse(status: string) {
  return {
    orderId: 'ord_airtime_500_abc123',
    customerRef: CUSTOMER_REF,
    status,
    billCategory: 'airtime',
    amountNgn: 500,
    amountStableCoin: LOCKED_COST,
    wallet: LINQ_DEPOSIT_WALLET,
    description: 'Airtime purchase',
  };
}

describe('Airtime flow (#1141)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockNetworkName.current = 'mainnet';
    mockGetCustomerRef.mockResolvedValue(CUSTOMER_REF);
    mockGetFeePayerAddress.mockResolvedValue(REFUND_ADDRESS);
    mockGetOnrampRate.mockResolvedValue(RATE);
    mockIsNairaVerified.mockResolvedValue(true);
    mockGetBillOrders.mockResolvedValue([]);
    // The screen persists the reservation with `.catch(...)` before spending.
    mockSaveBillOrder.mockImplementation(async () => undefined);
    mockPreviewSpendFee.mockResolvedValue(null);
    mockPayBill.mockResolvedValue(orderResponse());
    mockSpendAsset.mockResolvedValue('airtime_spend_hash_abc123');
    mockGetBillStatus.mockResolvedValue(statusResponse('pending'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('takes the happy path from form to a delivered top-up', async () => {
    mockGetBillStatus.mockResolvedValue(statusResponse('settled'));

    const root = await renderScreen();
    await enterForm(root);

    // The confirm step shows what will be spent before the passkey prompt.
    const confirmText = getAllText(root);
    expect(confirmText).toContain('₦500 airtime to 08031234567 costs');
    expect(confirmText).toContain('0.34 USDC');
    expect(confirmText).toContain('Network fee');
    expect(confirmText).toContain('Sponsored');

    await slideToPay(root);

    // A vend that settles must be reported as sent, with the number it went to.
    const doneText = getAllText(root);
    expect(doneText).toContain('Airtime sent');
    expect(doneText).toContain('₦500 is on 08031234567');
    expect(doneText).toContain('You spent');
    expect(doneText).toContain('0.34 USDC');

    // The spend went to the reserved order's wallet, for the locked amount.
    expect(mockPayBill).toHaveBeenCalledWith({
      customerRef: CUSTOMER_REF,
      billCategory: 'airtime',
      provider: 'MTN',
      customerId: PHONE,
      amountNgn: 500,
      amountStableCoin: LOCKED_COST,
      rate: RATE,
      coin: 'usdc',
      refundAddress: REFUND_ADDRESS,
    });
    expect(mockSpendAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        to: LINQ_DEPOSIT_WALLET,
        amount: String(LOCKED_COST),
      }),
    );
  });

  it('shows the Veil fee before the passkey and stops when the wallet cannot cover the spend', async () => {
    mockPreviewSpendFee.mockResolvedValue({
      amount: '0.05',
      assetCode: 'USDC',
      assetIssuer: null,
      destination: FEE_DESTINATION,
    });
    mockSpendAsset.mockRejectedValue(new NotEnoughToSend(0.2, LOCKED_COST, 'USDC'));

    const root = await renderScreen();
    await enterForm(root);

    // Disclosed on the confirm step, not discovered in the history afterwards.
    const confirmText = getAllText(root);
    expect(confirmText).toContain('Veil fee');
    expect(confirmText).toContain('0.05 USDC');
    expect(root.findAllByType('SlideToConfirm')).toHaveLength(1);

    await slideToPay(root);

    // The person is told what the wallet holds and that it is short — not sent
    // to a terminal failure, and not told they were charged.
    const text = getAllText(root);
    expect(text).toContain('This wallet holds 0.2 USDC, less than this top-up needs.');
    expect(text).not.toContain('Airtime sent');
    expect(text).not.toContain('Payment failed');
    // Still on the confirm step, with the order intact and nothing polled.
    expect(root.findAllByType('SlideToConfirm')).toHaveLength(1);
    expect(mockGetBillStatus).not.toHaveBeenCalled();
  });

  it('stays on the confirm step and names the reason when the spend fails', async () => {
    mockSpendAsset.mockRejectedValue(
      new Error('The spending account could not cover the network fee.'),
    );

    const root = await renderScreen();
    await enterForm(root);
    await slideToPay(root);

    const text = getAllText(root);
    expect(text).toContain('The spending account could not cover the network fee.');
    // No crypto left the wallet, so this is not a failed payment and must not
    // claim to be one.
    expect(text).not.toContain('Payment failed');
    expect(text).not.toContain('Airtime sent');
    expect(root.findAllByType('SlideToConfirm')).toHaveLength(1);
    expect(mockGetBillStatus).not.toHaveBeenCalled();
  });

  it('reports a poll timeout as unconfirmed, never as a failure', async () => {
    mockGetBillStatus.mockResolvedValue(statusResponse('pending'));

    const root = await renderScreen();
    await enterForm(root);
    await slideToPay(root);

    // The bounded wait is 12 polls at 10 seconds apart.
    for (let i = 0; i < 12; i++) {
      await renderer.act(async () => {
        jest.advanceTimersByTime(10_000);
      });
    }

    const text = getAllText(root);
    expect(text).toContain('Delivery taking longer than usual');
    expect(text).toContain('Confirmation from MTN is taking longer than usual.');
    expect(text).toContain('Your top-up may already have arrived.');
    // The person has already been charged; saying it failed invites a second payment.
    expect(text).not.toContain('Payment failed');
    expect(text).toContain('left this wallet');
  });

  it('reports repeated poll errors as unconfirmed after three attempts', async () => {
    mockGetBillStatus.mockRejectedValue(new Error('network unreachable'));

    const root = await renderScreen();
    await enterForm(root);
    await slideToPay(root);

    // First check fails immediately, then two interval retries reach the budget.
    for (let i = 0; i < 2; i++) {
      await renderer.act(async () => {
        jest.advanceTimersByTime(10_000);
      });
    }

    const text = getAllText(root);
    expect(text).toContain("Couldn't confirm status");
    expect(text).toContain('Checking status failed after 3 attempts.');
    expect(text).toContain('your top-up may already have arrived');
    expect(text).not.toContain('Payment failed');
  });
});
