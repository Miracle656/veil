/**
 * Tests for airtime purchase flow and status polling (V276).
 *
 * Acceptance criteria:
 * - A completed bill reaches a done state, with a test driving the real status value ('completed')
 * - A poll that errors is retried visibly and gives up with an explanation, not a spinner
 * - The screen never waits indefinitely (bounded wait)
 * - A user who has already received the airtime is never told the purchase failed
 */

import React from 'react';
import { Keypair } from '@stellar/stellar-sdk';

const mockFeePayerAddress = Keypair.random().publicKey();
const mockOrderWalletAddress = Keypair.random().publicKey();

const mockRouter = {
  back: jest.fn(),
  push: jest.fn(),
  canGoBack: jest.fn(() => true),
};

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
}));

jest.mock('../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      background: '#0F0F0F',
      surface: 'rgba(255,255,255,0.03)',
      surfaceRaised: '#1C1C1E',
      surfaceMd: 'rgba(255,255,255,0.06)',
      border: 'rgba(255,255,255,0.08)',
      borderStrong: 'rgba(255,255,255,0.22)',
      textStrong: '#FFFFFF',
      textPrimary: '#F6F7F8',
      textSecondary: '#A0A0A0',
      textMuted: '#666666',
      textFaint: '#444444',
      accent: '#FDDA24',
      accentText: '#FDDA24',
      onAccent: '#000000',
      danger: '#FF4D4D',
      dangerSurface: 'rgba(255,77,77,0.1)',
      label: '#888888',
      positive: '#00D092',
      positiveSurface: 'rgba(0,208,146,0.1)',
      lilac: '#C4A1FF',
    },
  }),
}));

jest.mock('../hooks/useNetwork', () => ({
  useNetwork: () => ({ networkName: 'mainnet' }),
}));

jest.mock('../components/SlideToConfirm', () => ({
  SlideToConfirm: ({ onConfirm, testID = 'slide-to-confirm' }: { onConfirm: () => void; testID?: string }) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Pressable, Text, View } = require('react-native');
    return (
      <View testID={testID}>
        <Pressable testID="slide-to-confirm-btn" onPress={onConfirm}>
          <Text>Slide</Text>
        </Pressable>
      </View>
    );
  },
}));

jest.mock('../components/WalletProvider', () => ({
  useWallet: () => ({ wallet: { deploy: jest.fn() } }),
}));

jest.mock('../lib/activity', () => ({
  getFeePayerAddress: jest.fn(async () => mockFeePayerAddress),
}));

jest.mock('../lib/pickContact', () => ({
  pickContactNumber: jest.fn(),
}));

const mockSpendAsset = jest.fn();
jest.mock('../lib/spendAsset', () => {
  return {
    NotEnoughToSend: class NotEnoughToSend extends Error {},
    previewSpendFee: jest.fn(async () => null),
    spendAsset: (...args: unknown[]) => mockSpendAsset(...args),
  };
});

const mockGetBillStatus = jest.fn();
const mockPayBill = jest.fn();
const mockGetOnrampRate = jest.fn();
const mockIsNairaVerified = jest.fn();

jest.mock('../lib/onramp', () => {
  const actual = jest.requireActual('../lib/onramp');
  return {
    ...actual,
    getCustomerRef: jest.fn(async () => 'cust_ref_123'),
    isNairaVerified: (...args: unknown[]) => mockIsNairaVerified(...args),
    getOnrampRate: (...args: unknown[]) => mockGetOnrampRate(...args),
    payBill: (...args: unknown[]) => mockPayBill(...args),
    getBillStatus: (...args: unknown[]) => mockGetBillStatus(...args),
  };
});

import AirtimeScreen, { MAX_CONSECUTIVE_POLL_ERRORS, MAX_POLL_ATTEMPTS } from '../app/airtime';

type Instance = { props: Record<string, any>; children: (Instance | string)[] };
type Renderer = {
  act: (fn: () => Promise<void> | void) => Promise<void>;
  create: (el: unknown) => { root: { findByProps: (p: object) => Instance; findAllByProps: (p: object) => Instance[] } };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer: Renderer = require('react-test-renderer');

function allText(node: Instance): string {
  return (node.children || [])
    .map((c) => (typeof c === 'string' ? c : allText(c)))
    .join('');
}

async function renderScreen() {
  let tree!: ReturnType<Renderer['create']>;
  await renderer.act(async () => {
    tree = renderer.create(<AirtimeScreen />);
  });
  return tree.root;
}

/** Navigates from form step to paying step */
async function proceedToPaying(root: ReturnType<Renderer['create']>['root']) {
  // Fill phone number
  const phoneInput = root.findByProps({ testID: 'airtime-phone-input' });
  await renderer.act(async () => {
    phoneInput.props.onChangeText('08035124471');
  });

  // Fill amount
  const amountInput = root.findByProps({ testID: 'airtime-amount-input' });
  await renderer.act(async () => {
    amountInput.props.onChangeText('1000');
  });

  // Click continue
  const continueBtn = root.findByProps({ testID: 'airtime-continue-btn' });
  await renderer.act(async () => {
    continueBtn.props.onPress();
  });

  // Slide to confirm
  const slideBtn = root.findByProps({ testID: 'slide-to-confirm-btn' });
  await renderer.act(async () => {
    slideBtn.props.onPress();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();

  mockGetOnrampRate.mockResolvedValue(1500);
  mockIsNairaVerified.mockResolvedValue(true);
  mockPayBill.mockResolvedValue({
    id: 'ord_airtime_123',
    wallet: mockOrderWalletAddress,
  });
  mockSpendAsset.mockResolvedValue('0xtxhash123');
});

afterEach(() => {
  jest.useRealTimers();
});

describe('AirtimeScreen polling and status resolution', () => {
  it('drives real provider status value "completed" to done state', async () => {
    // Return real provider status value: literally 'completed'
    mockGetBillStatus.mockResolvedValue({
      orderId: 'ord_airtime_123',
      customerRef: 'cust_ref_123',
      status: 'completed',
      billCategory: 'airtime',
      amountNgn: 1000,
      amountStableCoin: 0.67,
      wallet: mockOrderWalletAddress,
      description: 'MTN 1000',
    });

    const root = await renderScreen();
    await proceedToPaying(root);

    // Initial check should have run
    expect(mockGetBillStatus).toHaveBeenCalledWith('cust_ref_123', 'ord_airtime_123');

    // Done state is reached
    const doneScreens = root.findAllByProps({ testID: 'airtime-done-screen' });
    expect(doneScreens.length).toBeGreaterThan(0);
    const content = allText(doneScreens[0]);
    expect(content).toContain('Airtime sent');
    expect(content).toContain('08035124471');

    // Failed screen is not rendered
    expect(root.findAllByProps({ testID: 'airtime-failed-screen' })).toHaveLength(0);
  });

  it('visibly retries when a poll errors, distinguishing it from pending', async () => {
    // First poll errors
    mockGetBillStatus.mockRejectedValueOnce(new Error('Network request failed'));

    const root = await renderScreen();
    await proceedToPaying(root);

    expect(mockGetBillStatus).toHaveBeenCalledTimes(1);

    // The screen is still in paying step, but visibly indicates retrying
    const waitTextNode = root.findByProps({ testID: 'airtime-wait-text' });
    const waitText = allText(waitTextNode);
    expect(waitText).toContain('Checking status failed — retrying (1/3)');

    // Now second poll succeeds with 'completed'
    mockGetBillStatus.mockResolvedValueOnce({
      orderId: 'ord_airtime_123',
      customerRef: 'cust_ref_123',
      status: 'completed',
      billCategory: 'airtime',
      amountNgn: 1000,
      amountStableCoin: 0.67,
      wallet: mockOrderWalletAddress,
      description: 'MTN 1000',
    });

    await renderer.act(async () => {
      jest.advanceTimersByTime(10_000);
    });

    expect(mockGetBillStatus).toHaveBeenCalledTimes(2);

    // Reaches done state
    expect(root.findAllByProps({ testID: 'airtime-done-screen' }).length).toBeGreaterThan(0);
  });

  it('gives up with an explanation (not a spinner) after consecutive poll errors and never says payment failed', async () => {
    // Repeated poll errors
    mockGetBillStatus.mockRejectedValue(new Error('Gateway timeout 504'));

    const root = await renderScreen();
    await proceedToPaying(root);

    // Initial check (1st error)
    expect(mockGetBillStatus).toHaveBeenCalledTimes(1);

    // Advance 10s for 2nd error
    await renderer.act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    expect(mockGetBillStatus).toHaveBeenCalledTimes(2);

    // Advance 10s for 3rd error (hits MAX_CONSECUTIVE_POLL_ERRORS = 3)
    await renderer.act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    expect(mockGetBillStatus).toHaveBeenCalledTimes(3);

    // Polling has given up: spinner is gone, unconfirmed explanation screen is shown
    const unconfirmedScreens = root.findAllByProps({ testID: 'airtime-unconfirmed-screen' });
    expect(unconfirmedScreens.length).toBeGreaterThan(0);

    const screenText = allText(unconfirmedScreens[0]);
    expect(screenText).toContain("Couldn't confirm status");
    expect(screenText).toContain(`Checking status failed after ${MAX_CONSECUTIVE_POLL_ERRORS} attempts`);

    // Must NEVER tell the user the payment failed (money left, top-up may have arrived)
    expect(root.findAllByProps({ testID: 'airtime-failed-screen' })).toHaveLength(0);
    expect(screenText).not.toContain('Payment failed');
    expect(screenText).not.toContain('being returned to this wallet');

    // Explains what is known: money left, top-up may have arrived, how to check
    const rootText = allText(root as unknown as Instance);
    expect(rootText).toContain('left this wallet');
    expect(rootText).toContain('may already have arrived');
    expect(rootText).toContain('Check the recipient');

    // Further timer ticks do not keep polling
    await renderer.act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(mockGetBillStatus).toHaveBeenCalledTimes(3);
  });

  it('enforces a bounded wait and never waits indefinitely', async () => {
    // Returns pending indefinitely
    mockGetBillStatus.mockResolvedValue({
      orderId: 'ord_airtime_123',
      customerRef: 'cust_ref_123',
      status: 'pending',
      billCategory: 'airtime',
      amountNgn: 1000,
      amountStableCoin: 0.67,
      wallet: mockOrderWalletAddress,
      description: 'MTN 1000',
    });

    const root = await renderScreen();
    await proceedToPaying(root);

    // Initial check is attempt 1
    expect(mockGetBillStatus).toHaveBeenCalledTimes(1);

    // Advance through the remaining attempts up to MAX_POLL_ATTEMPTS (12)
    for (let i = 2; i <= MAX_POLL_ATTEMPTS; i++) {
      await renderer.act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      expect(mockGetBillStatus).toHaveBeenCalledTimes(i);
    }

    // Bounded wait reached: stops polling, shows unconfirmed screen with honest explanation
    const unconfirmedScreens = root.findAllByProps({ testID: 'airtime-unconfirmed-screen' });
    expect(unconfirmedScreens.length).toBeGreaterThan(0);

    const screenText = allText(unconfirmedScreens[0]);
    expect(screenText).toContain('Delivery taking longer than usual');
    expect(screenText).toContain('taking longer than usual. Your top-up may already have arrived');

    // Never told the purchase failed
    expect(root.findAllByProps({ testID: 'airtime-failed-screen' })).toHaveLength(0);

    // Does not continue polling indefinitely
    await renderer.act(async () => {
      jest.advanceTimersByTime(50_000);
    });
    expect(mockGetBillStatus).toHaveBeenCalledTimes(MAX_POLL_ATTEMPTS);
  });

  it('allows manual check status from the unconfirmed screen and resolves to done if status is completed', async () => {
    // 3 errors to get to unconfirmed state
    mockGetBillStatus.mockRejectedValue(new Error('503 Service Unavailable'));

    const root = await renderScreen();
    await proceedToPaying(root);

    for (let i = 0; i < 2; i++) {
      await renderer.act(async () => {
        jest.advanceTimersByTime(10_000);
      });
    }

    expect(root.findAllByProps({ testID: 'airtime-unconfirmed-screen' }).length).toBeGreaterThan(0);

    // Now provider has settled: status is 'completed'
    mockGetBillStatus.mockResolvedValueOnce({
      orderId: 'ord_airtime_123',
      customerRef: 'cust_ref_123',
      status: 'completed',
      billCategory: 'airtime',
      amountNgn: 1000,
      amountStableCoin: 0.67,
      wallet: mockOrderWalletAddress,
      description: 'MTN 1000',
    });

    const checkAgainBtn = root.findByProps({ testID: 'airtime-check-again-btn' });
    await renderer.act(async () => {
      checkAgainBtn.props.onPress();
    });

    // Successfully transitions to done!
    expect(root.findAllByProps({ testID: 'airtime-done-screen' }).length).toBeGreaterThan(0);
    expect(allText(root.findByProps({ testID: 'airtime-done-screen' }))).toContain('Airtime sent');
  });
});
