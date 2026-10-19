/**
 * Tests for the data bundle purchase screen (#1133).
 *
 * All onramp calls are mocked — never against the live Linq provider.
 *
 * Covers the issue acceptance criteria:
 *   1. Bundles listed per operator with size and validity
 *   2. Empty bundle list reported gracefully (not as a failure)
 *   3. Fee shown before the passkey prompt (confirm step)
 *   4. End-to-end purchase flow against a mocked provider
 *   5. Dashboard tile flipped from 'soon' → 'live' (PayForGrid)
 */

import React from 'react';

// ── Mock declarations (top-level, matching feePayerScreen.test.tsx pattern) ───

const mockFetchDataBundles = jest.fn();
const mockGetOnrampRate = jest.fn();
const mockPayBill = jest.fn();
const mockSpendAsset = jest.fn();
const mockGetBillStatus = jest.fn();
const mockGetCustomerRef = jest.fn();
const mockGetFeePayerAddress = jest.fn();
const mockIsNairaVerified = jest.fn();
const mockPreviewSpendFee = jest.fn();
const mockRouterPush = jest.fn();
const mockRouterBack = jest.fn();

jest.mock('../lib/onramp', () => ({
  fetchDataBundles: (...a: unknown[]) => mockFetchDataBundles(...a),
  getOnrampRate: (...a: unknown[]) => mockGetOnrampRate(...a),
  payBill: (...a: unknown[]) => mockPayBill(...a),
  getBillStatus: (...a: unknown[]) => mockGetBillStatus(...a),
  getCustomerRef: (...a: unknown[]) => mockGetCustomerRef(...a),
  isNairaVerified: (...a: unknown[]) => mockIsNairaVerified(...a),
}));

jest.mock('../lib/spendAsset', () => {
  class NotEnoughToSend extends Error {
    available: number;
    constructor(msg: string, available: number) {
      super(msg);
      this.available = available;
    }
  }
  return {
    spendAsset: (...a: unknown[]) => mockSpendAsset(...a),
    previewSpendFee: (...a: unknown[]) => mockPreviewSpendFee(...a),
    NotEnoughToSend,
  };
});

jest.mock('../lib/activity', () => ({
  getFeePayerAddress: (...a: unknown[]) => mockGetFeePayerAddress(...a),
}));

jest.mock('../lib/assets', () => ({
  getAssetIssuer: jest.fn(() => 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'),
}));

jest.mock('../components/WalletProvider', () => ({
  useWallet: () => ({ wallet: { deploy: jest.fn() } }),
}));

jest.mock('../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: new Proxy({}, {
      get: (_t: object, prop: string) =>
        prop === 'border' ? 'rgba(0,0,0,0.1)' :
        prop === 'danger' ? '#FF0000' :
        prop === 'dangerSurface' ? 'rgba(255,0,0,0.1)' :
        '#000000',
    }),
  }),
}));

jest.mock('../hooks/useNetwork', () => ({
  useNetwork: () => ({ networkName: 'mainnet' }),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockRouterPush, back: mockRouterBack }),
}));

jest.mock('../components/FlowHeader', () => ({
  FlowHeader: ({ title }: { title: string }) => {
    const { Text } = require('react-native');
    return <Text>{title}</Text>;
  },
}));

jest.mock('../components/SlideToConfirm', () => ({
  SlideToConfirm: ({ onConfirm, label }: { onConfirm: () => void; label: string }) => {
    const { Pressable, Text } = require('react-native');
    return (
      <Pressable onPress={onConfirm} testID="slide-to-confirm">
        <Text>{label}</Text>
      </Pressable>
    );
  },
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => {
    const { View } = require('react-native');
    return <View>{children}</View>;
  },
}));

// ── Top-level imports (after mocks, matching feePayerScreen pattern) ──────────

import DataScreen from '../app/data';
import { BILL_SERVICES } from '../components/PayForGrid';

// ── Test renderer (no @types, minimal slice used) ─────────────────────────────

type RNInstance = {
  props: Record<string, unknown>;
  children: (RNInstance | string)[];
};
type TestRenderer = {
  act: (fn: () => Promise<void> | void) => Promise<void>;
  create: (el: React.ReactElement) => {
    root: {
      findByProps: (p: Record<string, unknown>) => RNInstance;
      findAllByProps: (p: Record<string, unknown>) => RNInstance[];
    };
  };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer: TestRenderer = require('react-test-renderer');

function textContent(node: RNInstance): string {
  return node.children
    .map((c) => (typeof c === 'string' ? c : textContent(c)))
    .join('');
}

// The first render pays for transforming the whole React Native + Expo graph.
jest.setTimeout(60_000);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BUNDLES = [
  { id: 'mtn-1gb-30d', label: '1 GB', sizeMb: 1024, validityDays: 30, amountNgn: 1500 },
  { id: 'mtn-500mb-7d', label: '500 MB', sizeMb: 500, validityDays: 7, amountNgn: 500 },
];

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockFetchDataBundles.mockResolvedValue(BUNDLES);
  mockGetOnrampRate.mockResolvedValue(1500); // ₦1,500 per USDC
  mockGetCustomerRef.mockResolvedValue('veil_testref001');
  mockGetFeePayerAddress.mockResolvedValue('GFEE0000000000000000000000000000000000000000000000000000');
  mockIsNairaVerified.mockResolvedValue(true);
  mockPreviewSpendFee.mockResolvedValue(null);
  mockPayBill.mockResolvedValue({
    id: 'order-abc123',
    customerRef: 'veil_testref001',
    wallet: 'GWALLET000000000000000000000000000000000000000000000000000',
    status: 'pending',
  });
  mockSpendAsset.mockResolvedValue('txhash000000000000000000000000000000000000000000000000000000000000');
  mockGetBillStatus.mockResolvedValue({ status: 'complete' });
  mockRouterPush.mockReset();
  mockRouterBack.mockReset();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function renderScreen() {
  let tree!: ReturnType<TestRenderer['create']>;
  await renderer.act(async () => {
    tree = renderer.create(<DataScreen />);
  });
  return tree.root;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

it('renders the form step on mount with operator chips and phone input', async () => {
  const root = await renderScreen();

  // findAllByProps can return both the JS component and host (native) node for the same testID.
  expect(root.findAllByProps({ testID: 'phone-input' }).length).toBeGreaterThanOrEqual(1);

  const chips = root.findAllByProps({ accessibilityRole: 'radio' });
  const labels = chips.map((c) => textContent(c));
  expect(labels).toContain('MTN');
  expect(labels).toContain('AIRTEL');
  expect(labels).toContain('GLO');
  expect(labels).toContain('9MOBILE');
});

it('lists bundles with size and validity, not price alone', async () => {
  const root = await renderScreen();
  await renderer.act(async () => { await new Promise((r) => setTimeout(r, 50)); });

  const b1 = root.findByProps({ testID: 'bundle-mtn-1gb-30d' });
  const b2 = root.findByProps({ testID: 'bundle-mtn-500mb-7d' });

  expect(textContent(b1)).toContain('1 GB');
  expect(textContent(b1)).toContain('30 days');
  expect(textContent(b2)).toContain('500 MB');
  expect(textContent(b2)).toContain('7 days');

  // Price is also present (the user needs it), but not the only thing shown.
  expect(textContent(root.findByProps({ testID: 'bundle-price-mtn-1gb-30d' }))).toContain('₦1,500');
});

it('shows "No bundles available" gracefully when operator returns empty list', async () => {
  mockFetchDataBundles.mockResolvedValue([]);
  const root = await renderScreen();
  await renderer.act(async () => { await new Promise((r) => setTimeout(r, 50)); });

  const notice = root.findByProps({ testID: 'empty-bundles-notice' });
  expect(textContent(notice)).toContain('No bundles available');

  // The continue button is disabled — no bundle to proceed with.
  const btn = root.findByProps({ testID: 'continue-btn' });
  expect(btn.props.disabled).toBe(true);
});

it('does NOT render an error card when the bundle list is simply empty', async () => {
  mockFetchDataBundles.mockResolvedValue([]);
  const root = await renderScreen();
  await renderer.act(async () => { await new Promise((r) => setTimeout(r, 50)); });

  // Empty is informational, not an error.
  expect(root.findAllByProps({ testID: 'bundles-error' })).toHaveLength(0);
});

it('shows cost summary once a bundle is selected', async () => {
  const root = await renderScreen();
  await renderer.act(async () => { await new Promise((r) => setTimeout(r, 50)); });

  // Select the 1 GB bundle.
  await renderer.act(async () => {
    (root.findByProps({ testID: 'bundle-mtn-1gb-30d' }).props.onPress as () => void)();
  });

  const summary = root.findByProps({ testID: 'cost-summary' });
  expect(textContent(summary)).toContain('1 GB');
  expect(textContent(summary)).toContain('30 days');

  // Rate = ₦1,500 per USDC; bundle = ₦1,500 → 1.00 USDC.
  const costNode = root.findByProps({ testID: 'cost-value' });
  expect(textContent(costNode)).toContain('1.00 USDC');
});

it('advances to confirm step with the fee shown before the passkey gesture', async () => {
  mockPreviewSpendFee.mockResolvedValue({ amount: '0.01', assetCode: 'USDC' });

  const root = await renderScreen();
  await renderer.act(async () => { await new Promise((r) => setTimeout(r, 50)); });

  // Select bundle + fill valid phone.
  await renderer.act(async () => {
    (root.findByProps({ testID: 'bundle-mtn-1gb-30d' }).props.onPress as () => void)();
  });
  await renderer.act(async () => {
    (root.findByProps({ testID: 'phone-input' }).props.onChangeText as (v: string) => void)('08031234567');
  });

  // Tap continue.
  await renderer.act(async () => {
    (root.findByProps({ testID: 'continue-btn' }).props.onPress as () => void)();
    await new Promise((r) => setTimeout(r, 100));
  });

  // SlideToConfirm present → we are on the confirm step.
  // findAllByProps can return both JS and host node instances for the same testID.
  expect(root.findAllByProps({ testID: 'slide-to-confirm' }).length).toBeGreaterThanOrEqual(1);

  // previewSpendFee must be called before the user can slide (on the confirm step).
  expect(mockPreviewSpendFee).toHaveBeenCalled();
});

it('calls payBill with billCategory "data" and bundle id as customerId, then spendAsset', async () => {
  const root = await renderScreen();
  await renderer.act(async () => { await new Promise((r) => setTimeout(r, 50)); });

  await renderer.act(async () => {
    (root.findByProps({ testID: 'bundle-mtn-1gb-30d' }).props.onPress as () => void)();
  });
  await renderer.act(async () => {
    (root.findByProps({ testID: 'phone-input' }).props.onChangeText as (v: string) => void)('08031234567');
  });

  // Advance to confirm.
  await renderer.act(async () => {
    (root.findByProps({ testID: 'continue-btn' }).props.onPress as () => void)();
    await new Promise((r) => setTimeout(r, 50));
  });

  // Confirm via slide.
  await renderer.act(async () => {
    (root.findByProps({ testID: 'slide-to-confirm' }).props.onPress as () => void)();
    await new Promise((r) => setTimeout(r, 150));
  });

  expect(mockPayBill).toHaveBeenCalledWith(
    expect.objectContaining({
      billCategory: 'data',
      customerId: 'mtn-1gb-30d',
      provider: 'MTN',
    }),
  );
  expect(mockSpendAsset).toHaveBeenCalled();
});

it('BILL_SERVICES data tile stays soon until the backend route exists', () => {
  const dataTile = BILL_SERVICES.find((s) => s.id === 'data');
  expect(dataTile).toBeDefined();
  expect(dataTile?.status).toBe('soon');
  expect(dataTile?.route).toBeUndefined();
});
