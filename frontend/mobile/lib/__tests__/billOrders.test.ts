import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearBillOrders,
  getBillOrder,
  getBillOrders,
  isTerminalStatus,
  recheckPendingBillOrders,
  retrieveBillToken,
  saveBillOrder,
  sanitizeBillOrder,
  BILL_ORDERS_KEY,
} from '../billOrders';
import type { BillStatus } from '../onramp';

describe('billOrders', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  describe('privacy & sanitization', () => {
    it('strips sensitive identity data and preserves only allowed order fields', () => {
      const sanitized = sanitizeBillOrder({
        orderId: 'ord_12345',
        customerRef: 'usr_abcde',
        category: 'electricity',
        provider: 'IKEDC',
        identifier: '014256789012',
        amount: 5000,
        amountCrypto: 3.4482758,
        asset: 'USDC',
        status: 'completed',
        time: 1700000000000,
        token: '1234-5678-9012-3456-7890',
        units: '35.4 kWh',
        meterType: 'prepaid',
        customerName: 'ADEKUNLE CHUKWUMA',
        // Forbidden fields that must be stripped:
        nin: '12345678901',
        bvn: '22223333444',
        password: 'secret_password',
        seedPhrase: 'twelve secret words here',
      });

      expect(sanitized.orderId).toBe('ord_12345');
      expect(sanitized.customerRef).toBe('usr_abcde');
      expect(sanitized.category).toBe('electricity');
      expect(sanitized.provider).toBe('IKEDC');
      expect(sanitized.identifier).toBe('014256789012');
      expect(sanitized.amount).toBe(5000);
      expect(sanitized.amountCrypto).toBe(3.4482758);
      expect(sanitized.asset).toBe('usdc');
      expect(sanitized.token).toBe('1234-5678-9012-3456-7890');
      expect(sanitized.units).toBe('35.4 kWh');
      expect(sanitized.meterType).toBe('prepaid');
      expect(sanitized.customerName).toBe('ADEKUNLE CHUKWUMA');

      // Ensure no private credentials leaked into the sanitized object
      expect((sanitized as unknown as Record<string, unknown>).nin).toBeUndefined();
      expect((sanitized as unknown as Record<string, unknown>).bvn).toBeUndefined();
      expect((sanitized as unknown as Record<string, unknown>).password).toBeUndefined();
      expect((sanitized as unknown as Record<string, unknown>).seedPhrase).toBeUndefined();
    });

    it('normalizes prepaidToken alias to token', () => {
      const sanitized = sanitizeBillOrder({
        orderId: 'ord_alias',
        customerRef: 'usr_ref',
        category: 'electricity',
        identifier: '014256789012',
        amount: 2000,
        prepaidToken: '9999-8888-7777-6666-5555',
      });

      expect(sanitized.token).toBe('9999-8888-7777-6666-5555');
    });
  });

  describe('persistence and token retrieval', () => {
    it('saves a bill order with prepaid token and retrieves it', async () => {
      await saveBillOrder({
        orderId: 'ord_elec_1',
        customerRef: 'cust_1',
        category: 'electricity',
        provider: 'IKEDC',
        identifier: '014256789012',
        amount: 5000,
        amountCrypto: 3.45,
        asset: 'usdc',
        status: 'completed',
        token: '4512-8923-0184-9921-4402',
        units: '34.5 kWh',
        customerName: 'CHUKWUMA OBI',
      });

      const orders = await getBillOrders();
      expect(orders).toHaveLength(1);
      expect(orders[0].orderId).toBe('ord_elec_1');
      expect(orders[0].token).toBe('4512-8923-0184-9921-4402');
      expect(orders[0].units).toBe('34.5 kWh');

      const retrievedToken = await retrieveBillToken('ord_elec_1');
      expect(retrievedToken).toBe('4512-8923-0184-9921-4402');
    });

    it('filters orders by category', async () => {
      await saveBillOrder({
        orderId: 'ord_airtime',
        customerRef: 'cust_1',
        category: 'airtime',
        identifier: '08031234567',
        amount: 1000,
      });

      await saveBillOrder({
        orderId: 'ord_electricity',
        customerRef: 'cust_1',
        category: 'electricity',
        provider: 'EKEDC',
        identifier: '014256789012',
        amount: 5000,
        token: '1111-2222-3333-4444-5555',
      });

      const elecOrders = await getBillOrders('electricity');
      expect(elecOrders).toHaveLength(1);
      expect(elecOrders[0].orderId).toBe('ord_electricity');

      const airtimeOrders = await getBillOrders('airtime');
      expect(airtimeOrders).toHaveLength(1);
      expect(airtimeOrders[0].orderId).toBe('ord_airtime');
    });

    it('updates existing order preserving token if not overwritten', async () => {
      await saveBillOrder({
        orderId: 'ord_update_test',
        customerRef: 'cust_1',
        category: 'electricity',
        identifier: '014256789012',
        amount: 5000,
        status: 'pending',
        token: '4512-8923-0184-9921-4402',
      });

      // Update without token specified
      await saveBillOrder({
        orderId: 'ord_update_test',
        customerRef: 'cust_1',
        category: 'electricity',
        identifier: '014256789012',
        amount: 5000,
        status: 'completed',
      });

      const updated = await getBillOrder('ord_update_test');
      expect(updated?.status).toBe('completed');
      expect(updated?.token).toBe('4512-8923-0184-9921-4402');
    });

    it('clears all bill orders', async () => {
      await saveBillOrder({
        orderId: 'ord_clear',
        customerRef: 'cust_1',
        category: 'electricity',
        identifier: '014256789012',
        amount: 3000,
      });

      await clearBillOrders();
      const orders = await getBillOrders();
      expect(orders).toEqual([]);
    });
  });

  describe('isTerminalStatus', () => {
    it('recognizes complete, success, delivered, failed, and refund as terminal', () => {
      expect(isTerminalStatus('completed')).toBe(true);
      expect(isTerminalStatus('complete')).toBe(true);
      expect(isTerminalStatus('success')).toBe(true);
      expect(isTerminalStatus('delivered')).toBe(true);
      expect(isTerminalStatus('failed')).toBe(true);
      expect(isTerminalStatus('refunded')).toBe(true);
      expect(isTerminalStatus('reversed')).toBe(true);
      expect(isTerminalStatus('cancelled')).toBe(true);

      expect(isTerminalStatus('pending')).toBe(false);
      expect(isTerminalStatus('initiated')).toBe(false);
      expect(isTerminalStatus('processing')).toBe(false);
      expect(isTerminalStatus('unconfirmed')).toBe(false);
    });
  });

  describe('recheckPendingBillOrders', () => {
    it('rechecks pending orders and stores returned token', async () => {
      await saveBillOrder({
        orderId: 'ord_pending_1',
        customerRef: 'cust_ref',
        category: 'electricity',
        provider: 'IKEDC',
        identifier: '014256789012',
        amount: 5000,
        status: 'pending',
      });

      const mockGetStatus = jest.fn().mockResolvedValue({
        orderId: 'ord_pending_1',
        customerRef: 'cust_ref',
        status: 'completed',
        billCategory: 'electricity',
        amountNgn: 5000,
        amountStableCoin: 3.45,
        wallet: 'GDXYZ',
        description: 'Delivered',
        token: '9876-5432-1098-7654-3210',
        units: '33.2 kWh',
      } as BillStatus);

      const rechecked = await recheckPendingBillOrders({ getStatusFn: mockGetStatus });
      expect(mockGetStatus).toHaveBeenCalledWith('cust_ref', 'ord_pending_1');
      expect(rechecked[0].status).toBe('completed');
      expect(rechecked[0].token).toBe('9876-5432-1098-7654-3210');
      expect(rechecked[0].units).toBe('33.2 kWh');

      // Verify token persisted to storage
      const token = await retrieveBillToken('ord_pending_1');
      expect(token).toBe('9876-5432-1098-7654-3210');
    });

    it('does not recheck terminal orders', async () => {
      await saveBillOrder({
        orderId: 'ord_done_1',
        customerRef: 'cust_ref',
        category: 'electricity',
        identifier: '014256789012',
        amount: 2000,
        status: 'completed',
        token: 'EXISTING_TOKEN',
      });

      const mockGetStatus = jest.fn();
      await recheckPendingBillOrders({ getStatusFn: mockGetStatus });
      expect(mockGetStatus).not.toHaveBeenCalled();
    });
  });
});
