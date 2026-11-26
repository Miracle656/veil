import React from 'react';
import * as Clipboard from 'expo-clipboard';
import { BILL_SERVICES } from '../components/PayForGrid';
import {
  DISCOS,
  formatToken,
  naira,
} from '../app/electricity';

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

const mockVerifyMeter = jest.fn();
const mockPayBill = jest.fn();
const mockGetBillStatus = jest.fn();
const mockGetOnrampRate = jest.fn();
const mockIsNairaVerified = jest.fn();
const mockGetCustomerRef = jest.fn();

jest.mock('../lib/onramp', () => {
  const actual = jest.requireActual('../lib/onramp');
  return {
    ...actual,
    verifyMeter: (...args: unknown[]) => mockVerifyMeter(...args),
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
  const React = require('react');
  return {
    SlideToConfirm: (props: { label: string; onConfirm: () => void }) => {
      return React.createElement('SlideToConfirm', props);
    },
  };
});

jest.mock('../components/FlowHeader', () => {
  const React = require('react');
  return {
    FlowHeader: (props: { title: string }) => {
      return React.createElement('FlowHeader', props);
    },
  };
});

import ElectricityScreen from '../app/electricity';

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
  return texts.join(' ');
}

async function renderScreen() {
  let tree!: ReturnType<Renderer['create']>;
  await renderer.act(async () => {
    tree = renderer.create(React.createElement(ElectricityScreen));
  });
  return tree.root;
}

describe('ElectricityScreen (#1134)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockNetworkName.current = 'mainnet';
    mockGetCustomerRef.mockResolvedValue('user_ref_123');
    mockGetFeePayerAddress.mockResolvedValue('G_REFUND_ADDRESS_123');
    mockGetOnrampRate.mockResolvedValue(1450);
    mockIsNairaVerified.mockResolvedValue(true);
    mockGetBillOrders.mockResolvedValue([]);
    mockPreviewSpendFee.mockResolvedValue({ amount: '0.00', assetCode: 'USDC' });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Static & formatting helpers', () => {
    it('defines all 11 Nigerian Discos', () => {
      expect(DISCOS.length).toBe(11);
      const discoIds = DISCOS.map((d) => d.id);
      expect(discoIds).toContain('IKEDC');
      expect(discoIds).toContain('EKEDC');
      expect(discoIds).toContain('AEDC');
      expect(discoIds).toContain('IBEDC');
      expect(discoIds).toContain('EEDC');
      expect(discoIds).toContain('PHED');
      expect(discoIds).toContain('KEDCO');
      expect(discoIds).toContain('JED');
      expect(discoIds).toContain('KAEDCO');
      expect(discoIds).toContain('BEDC');
      expect(discoIds).toContain('YEDC');
    });

    it('formats 20-digit prepaid tokens into 4-digit groups for readability', () => {
      expect(formatToken('45128923018499214402')).toBe('4512 - 8923 - 0184 - 9921 - 4402');
      expect(formatToken('4512-8923-0184-9921-4402')).toBe('4512 - 8923 - 0184 - 9921 - 4402');
    });

    it('formats naira amounts correctly', () => {
      expect(naira(5000)).toBe('₦5,000');
    });
  });

  describe('PayForGrid service tile', () => {
    it('flips the power tile to live with route /electricity', () => {
      const powerService = BILL_SERVICES.find((s) => s.id === 'power');
      expect(powerService).toBeDefined();
      expect(powerService?.status).toBe('live');
      expect(powerService?.route).toBe('/electricity');
    });
  });

  describe('Acceptance Criteria: Meter Verification & Blocking', () => {
    it('blocks purchase when meter is unverified or unverifiable', async () => {
      const root = await renderScreen();

      // Find meter input
      const meterInput = root.findByProps({ testID: 'meter-input' });
      expect(meterInput).toBeDefined();

      // Enter a meter number
      await renderer.act(async () => {
        meterInput.props.onChangeText?.('014256789012');
      });

      // Verification failure mock
      mockVerifyMeter.mockResolvedValueOnce({
        valid: false,
        error: 'Meter number not found for IKEDC',
      });

      // Press Verify button
      const verifyBtn = root.findByProps({ testID: 'verify-meter-button' });
      await renderer.act(async () => {
        verifyBtn.props.onPress?.();
      });

      expect(mockVerifyMeter).toHaveBeenCalledWith({
        disco: 'IKEDC',
        meterNumber: '014256789012',
        meterType: 'prepaid',
        customerRef: 'user_ref_123',
      });

      // Verify that error is displayed
      expect(getAllText(root)).toContain('Meter number not found for IKEDC');

      // Verify that Continue button is blocked
      const continueBtn = root.findByProps({ testID: 'continue-button' });
      expect(continueBtn.props.disabled).toBe(true);
      expect(getAllText(continueBtn)).toContain('Verify meter to continue');
    });

    it('verifies meter and shows returned customer name before taking money', async () => {
      const root = await renderScreen();

      const meterInput = root.findByProps({ testID: 'meter-input' });
      await renderer.act(async () => {
        meterInput.props.onChangeText?.('014256789012');
      });

      // Verification success mock
      mockVerifyMeter.mockResolvedValueOnce({
        valid: true,
        customerName: 'ADEKUNLE CHUKWUMA OBI',
        address: '14 VICTORIA GARDEN CITY, LEKKI',
        meterNumber: '014256789012',
        disco: 'IKEDC',
        meterType: 'prepaid',
      });

      const verifyBtn = root.findByProps({ testID: 'verify-meter-button' });
      await renderer.act(async () => {
        verifyBtn.props.onPress?.();
      });

      // Verified customer name must be visible on screen
      expect(getAllText(root)).toContain('ADEKUNLE CHUKWUMA OBI');

      // Address is shown
      expect(getAllText(root)).toContain('14 VICTORIA GARDEN CITY');

      // Enter amount
      const amountInput = root.findByProps({ testID: 'amount-input' });
      await renderer.act(async () => {
        amountInput.props.onChangeText?.('5000');
      });

      // Continue button is now enabled with "Continue"
      const continueBtn = root.findByProps({ testID: 'continue-button' });
      expect(continueBtn.props.disabled).toBe(false);
      expect(getAllText(continueBtn)).toContain('Continue');
    });
  });

  describe('Acceptance Criteria: User confirms name before passkey prompt', () => {
    it('requires explicit confirmation of customer name before SlideToConfirm is unlocked', async () => {
      const root = await renderScreen();

      // Enter meter and verify
      const meterInput = root.findByProps({ testID: 'meter-input' });
      await renderer.act(async () => {
        meterInput.props.onChangeText?.('014256789012');
      });

      mockVerifyMeter.mockResolvedValueOnce({
        valid: true,
        customerName: 'ADEKUNLE CHUKWUMA OBI',
        meterNumber: '014256789012',
        disco: 'IKEDC',
      });

      const verifyBtn = root.findByProps({ testID: 'verify-meter-button' });
      await renderer.act(async () => {
        verifyBtn.props.onPress?.();
      });

      // Enter amount and continue
      const amountInput = root.findByProps({ testID: 'amount-input' });
      await renderer.act(async () => {
        amountInput.props.onChangeText?.('5000');
      });

      const continueBtn = root.findByProps({ testID: 'continue-button' });
      await renderer.act(async () => {
        continueBtn.props.onPress?.();
      });

      // Now on Step 2 (confirm): Customer name must be shown
      expect(getAllText(root)).toContain('ADEKUNLE CHUKWUMA OBI');

      // SlideToConfirm must NOT be present before confirming the name
      expect(root.findAllByType('SlideToConfirm')).toHaveLength(0);

      // A locked card explains why
      expect(getAllText(root)).toContain('Confirm customer name above to unlock payment');

      // Find the confirmation checkbox row
      const checkbox = root.findByProps({ testID: 'confirm-customer-name-checkbox' });
      expect(checkbox).toBeDefined();

      // User confirms the customer name
      await renderer.act(async () => {
        checkbox.props.onPress?.();
      });

      // SlideToConfirm is now rendered and unlocked
      const sliders = root.findAllByType('SlideToConfirm');
      expect(sliders).toHaveLength(1);
    });
  });

  describe('Acceptance Criteria: Token-bearing success, copying, and persistence', () => {
    it('surfaces the prepaid token prominently on success, copies it, and saves it to order storage', async () => {
      const root = await renderScreen();

      // Form entry
      const meterInput = root.findByProps({ testID: 'meter-input' });
      await renderer.act(async () => {
        meterInput.props.onChangeText?.('014256789012');
      });

      mockVerifyMeter.mockResolvedValueOnce({
        valid: true,
        customerName: 'ADEKUNLE CHUKWUMA OBI',
        meterNumber: '014256789012',
        disco: 'IKEDC',
      });

      const verifyBtn = root.findByProps({ testID: 'verify-meter-button' });
      await renderer.act(async () => {
        verifyBtn.props.onPress?.();
      });

      const amountInput = root.findByProps({ testID: 'amount-input' });
      await renderer.act(async () => {
        amountInput.props.onChangeText?.('5000');
      });

      const continueBtn = root.findByProps({ testID: 'continue-button' });
      await renderer.act(async () => {
        continueBtn.props.onPress?.();
      });

      // Confirm name
      const checkbox = root.findByProps({ testID: 'confirm-customer-name-checkbox' });
      await renderer.act(async () => {
        checkbox.props.onPress?.();
      });

      // Slide to pay triggers payBill and spendAsset
      mockPayBill.mockResolvedValueOnce({
        id: 'ord_electricity_987',
        customerRef: 'user_ref_123',
        wallet: 'GDXYZ_LINQ_DEPOSIT',
        status: 'initiated',
      });
      mockSpendAsset.mockResolvedValueOnce('0x_stellar_spend_hash_123');

      // getBillStatus returns token on poll
      mockGetBillStatus.mockResolvedValueOnce({
        orderId: 'ord_electricity_987',
        customerRef: 'user_ref_123',
        status: 'completed',
        billCategory: 'electricity',
        amountNgn: 5000,
        amountStableCoin: 3.4482759,
        wallet: 'GDXYZ_LINQ_DEPOSIT',
        description: 'Vended',
        token: '45128923018499214402',
        units: '35.4 kWh',
      });

      const slider = root.findByType('SlideToConfirm');
      await renderer.act(async () => {
        slider.props.onConfirm();
      });

      // Advances timers for poll
      await renderer.act(async () => {
        jest.advanceTimersByTime(100);
      });

      // Success screen: token must be prominently surfaced
      expect(getAllText(root)).toContain('4512 - 8923 - 0184 - 9921 - 4402');

      // Units must be visible
      expect(getAllText(root)).toContain('35.4 kWh');

      // Copy Token button
      const copyBtn = root.findByProps({ testID: 'copy-token-button' });
      expect(copyBtn).toBeDefined();

      await renderer.act(async () => {
        copyBtn.props.onPress?.();
      });

      expect(Clipboard.setStringAsync).toHaveBeenCalledWith('45128923018499214402');

      // The token must survive leaving the screen: saved to order record
      expect(mockSaveBillOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: 'ord_electricity_987',
          customerRef: 'user_ref_123',
          category: 'electricity',
          provider: 'IKEDC',
          identifier: '014256789012',
          amount: 5000,
          token: '45128923018499214402',
          units: '35.4 kWh',
          status: 'completed',
        }),
      );
    });

    it('renders retrievable past meter tokens after leaving and returning to the screen', async () => {
      mockGetBillOrders.mockResolvedValueOnce([
        {
          orderId: 'past_ord_1',
          customerRef: 'user_ref_123',
          category: 'electricity',
          provider: 'IKEDC',
          identifier: '014256789012',
          amount: 5000,
          status: 'completed',
          time: Date.now() - 3600000,
          token: '12345678901234567890',
          customerName: 'ADEKUNLE CHUKWUMA OBI',
        },
      ]);

      const root = await renderScreen();

      // Recent Meter Tokens section exists
      expect(getAllText(root)).toContain('Recent Meter Tokens');

      // Past token is rendered and copyable
      expect(getAllText(root)).toContain('1234 - 5678 - 9012 - 3456 - 7890');
    });
  });

  describe('previewSpendFee & Unconfirmed Terminal Rule', () => {
    it('previews fee before passkey prompt on confirm step', async () => {
      mockPreviewSpendFee.mockResolvedValueOnce({
        amount: '0.00',
        assetCode: 'USDC',
      });

      const root = await renderScreen();

      // Form entry
      const meterInput = root.findByProps({ testID: 'meter-input' });
      await renderer.act(async () => {
        meterInput.props.onChangeText?.('014256789012');
      });

      mockVerifyMeter.mockResolvedValueOnce({
        valid: true,
        customerName: 'ADEKUNLE CHUKWUMA OBI',
      });
      const verifyBtn = root.findByProps({ testID: 'verify-meter-button' });
      await renderer.act(async () => {
        verifyBtn.props.onPress?.();
      });

      const amountInput = root.findByProps({ testID: 'amount-input' });
      await renderer.act(async () => {
        amountInput.props.onChangeText?.('5000');
      });

      const continueBtn = root.findByProps({ testID: 'continue-button' });
      await renderer.act(async () => {
        continueBtn.props.onPress?.();
      });

      // Preview spend fee must be called on confirm step before passkey
      expect(mockPreviewSpendFee).toHaveBeenCalled();
    });

    it('reports timeout as unconfirmed and warns not to pay again', async () => {
      const root = await renderScreen();

      // Form entry & verify
      const meterInput = root.findByProps({ testID: 'meter-input' });
      await renderer.act(async () => {
        meterInput.props.onChangeText?.('014256789012');
      });
      mockVerifyMeter.mockResolvedValueOnce({ valid: true, customerName: 'ADEKUNLE OBI' });
      const verifyBtn = root.findByProps({ testID: 'verify-meter-button' });
      await renderer.act(async () => {
        verifyBtn.props.onPress?.();
      });

      const amountInput = root.findByProps({ testID: 'amount-input' });
      await renderer.act(async () => {
        amountInput.props.onChangeText?.('5000');
      });
      const continueBtn = root.findByProps({ testID: 'continue-button' });
      await renderer.act(async () => {
        continueBtn.props.onPress?.();
      });

      // Confirm name
      const checkbox = root.findByProps({ testID: 'confirm-customer-name-checkbox' });
      await renderer.act(async () => {
        checkbox.props.onPress?.();
      });

      // Spend
      mockPayBill.mockResolvedValueOnce({
        id: 'ord_unconfirmed_1',
        customerRef: 'user_ref_123',
        wallet: 'GDXYZ_LINQ_DEPOSIT',
        status: 'initiated',
      });
      mockSpendAsset.mockResolvedValueOnce('0x_spend_hash_1');

      // Status always returns pending
      mockGetBillStatus.mockResolvedValue({
        orderId: 'ord_unconfirmed_1',
        customerRef: 'user_ref_123',
        status: 'pending',
        billCategory: 'electricity',
        amountNgn: 5000,
        amountStableCoin: 3.4482759,
        wallet: 'GDXYZ_LINQ_DEPOSIT',
        description: 'Processing',
      });

      const slider = root.findByType('SlideToConfirm');
      await renderer.act(async () => {
        slider.props.onConfirm();
      });

      // Advance timers through 15 poll attempts (15 * 10s = 150s)
      for (let i = 0; i < 16; i++) {
        await renderer.act(async () => {
          jest.advanceTimersByTime(10_000);
        });
      }

      // Step becomes unconfirmed, warning not to pay again
      expect(getAllText(root)).toContain('Do not pay again');
    });
  });
});
