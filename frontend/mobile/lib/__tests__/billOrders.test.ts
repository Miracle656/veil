/**
 * Bill Orders Persistence & Status Resolution Tests.
 *
 * Acceptance Criteria verified:
 *  - Bill orders are persisted with enough to re-query them
 *  - A prepaid token is retrievable after leaving the success screen
 *  - Non-terminal orders are re-checked on next open
 *  - No NIN or other identity data is stored
 *  - A test proves a pending order resolves after a restart
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearBillOrders,
  getBillOrder,
  getBillOrders,
  isTerminalStatus,
  recheckPendingBillOrders,
  retrieveBillToken,
  sanitizeBillOrder,
  saveBillOrder,
  updateBillOrderStatus,
  BILL_ORDERS_KEY,
  type PersistedBillOrder,
} from '../billOrders';
import type { BillStatus } from '../onramp';

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('bill order persistence & re-query readiness', () => {
  it('persists a bill order with enough information to re-query it', async () => {
    const order = {
      orderId: 'ord_elec_123',
      customerRef: 'veil_4sjjjzwamdoe',
      category: 'electricity' as const,
      provider: 'IKEDC',
      identifier: '10101234567',
      amount: 5000,
      amountCrypto: 3.33,
      asset: 'usdc',
      status: 'pending',
      time: 1729440000000,
    };

    await saveBillOrder(order);

    const saved = await getBillOrder('ord_elec_123');
    expect(saved).not.toBeNull();
    expect(saved?.orderId).toBe('ord_elec_123');
    expect(saved?.customerRef).toBe('veil_4sjjjzwamdoe');
    expect(saved?.category).toBe('electricity');
    expect(saved?.provider).toBe('IKEDC');
    expect(saved?.identifier).toBe('10101234567');
    expect(saved?.amount).toBe(5000);
    expect(saved?.amountCrypto).toBe(3.33);
    expect(saved?.asset).toBe('usdc');
    expect(saved?.status).toBe('pending');
    expect(saved?.time).toBe(1729440000000);

    // Both orderId and customerRef are stored, satisfying GET /ngn/bills/:orderId?customerRef=:customerRef
    expect(saved?.orderId).toBeDefined();
    expect(saved?.customerRef).toBeDefined();
  });

  it('sorts multiple orders by newest time first', async () => {
    await saveBillOrder({
      orderId: 'ord_1',
      customerRef: 'veil_ref1',
      category: 'airtime',
      identifier: '08031111111',
      amount: 1000,
      asset: 'usdc',
      time: 1000,
    });

    await saveBillOrder({
      orderId: 'ord_2',
      customerRef: 'veil_ref1',
      category: 'electricity',
      identifier: '10102222222',
      amount: 2000,
      asset: 'usdc',
      time: 3000,
    });

    await saveBillOrder({
      orderId: 'ord_3',
      customerRef: 'veil_ref1',
      category: 'data',
      identifier: '08033333333',
      amount: 1500,
      asset: 'usdc',
      time: 2000,
    });

    const orders = await getBillOrders();
    expect(orders.map((o) => o.orderId)).toEqual(['ord_2', 'ord_3', 'ord_1']);
  });

  it('updates an existing order without duplicating it', async () => {
    await saveBillOrder({
      orderId: 'ord_airtime_456',
      customerRef: 'veil_abc',
      category: 'airtime',
      identifier: '08031234567',
      amount: 1000,
      asset: 'usdc',
      status: 'pending',
    });

    await updateBillOrderStatus('ord_airtime_456', 'completed');

    const orders = await getBillOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe('completed');
  });
});

describe('prepaid token retrieval', () => {
  it('retrieves a prepaid electricity token after leaving the screen', async () => {
    // 1. User completes an electricity purchase and leaves the success screen
    await saveBillOrder({
      orderId: 'ord_electricity_789',
      customerRef: 'veil_user_1',
      category: 'electricity',
      provider: 'EKEDC',
      identifier: '04123456789',
      amount: 10000,
      asset: 'xlm',
      status: 'completed',
      time: Date.now(),
      token: '0000-1111-2222-3333-4444',
    });

    // 2. Later, order history is loaded on another screen or session
    const orders = await getBillOrders();
    const elecOrder = orders.find((o) => o.orderId === 'ord_electricity_789');

    expect(elecOrder).toBeDefined();
    // Prepaid token is retrievable!
    expect(elecOrder?.token).toBe('0000-1111-2222-3333-4444');
    expect(elecOrder?.category).toBe('electricity');
    expect(elecOrder?.identifier).toBe('04123456789');
  });

  it('accepts prepaidToken field alias from Linq response', async () => {
    await saveBillOrder({
      orderId: 'ord_elec_alias',
      customerRef: 'veil_user_1',
      category: 'electricity',
      identifier: '04123456789',
      amount: 5000,
      asset: 'usdc',
      status: 'completed',
      prepaidToken: '1111-2222-3333-4444',
    });

    const order = await getBillOrder('ord_elec_alias');
    expect(order?.token).toBe('1111-2222-3333-4444');
  });
});

describe('privacy: no NIN or identity data stored', () => {
  it('strips NIN, BVN, names, and contact details from storage', async () => {
    const rawInputWithIdentity = {
      orderId: 'ord_privacy_check',
      customerRef: 'veil_ref_safe',
      category: 'electricity' as const,
      provider: 'IBEDC',
      identifier: '62112345678', // meter number is customer identifier, allowed
      amount: 3000,
      asset: 'usdc',
      status: 'completed',
      time: 1729441111111,
      token: '0000-1111-2222-3333',
      // Prohibited identity fields that must NEVER appear:
      nin: '12345678901',
      bvn: '22233344455',
      accountHolderName: 'Chinedu Okonkwo',
      email: 'chinedu@example.com',
      phone: '08039999999',
      firstName: 'Chinedu',
      lastName: 'Okonkwo',
    };

    await saveBillOrder(rawInputWithIdentity);

    // Read back via API
    const order = await getBillOrder('ord_privacy_check');
    expect(order).toBeDefined();
    expect((order as unknown as Record<string, unknown>).nin).toBeUndefined();
    expect((order as unknown as Record<string, unknown>).bvn).toBeUndefined();
    expect((order as unknown as Record<string, unknown>).accountHolderName).toBeUndefined();
    expect((order as unknown as Record<string, unknown>).email).toBeUndefined();
    expect((order as unknown as Record<string, unknown>).phone).toBeUndefined();
    expect((order as unknown as Record<string, unknown>).firstName).toBeUndefined();
    expect((order as unknown as Record<string, unknown>).lastName).toBeUndefined();

    // Inspect the exact raw string in AsyncStorage
    const rawStorage = (await AsyncStorage.getItem(BILL_ORDERS_KEY)) ?? '';
    expect(rawStorage).not.toContain('12345678901');
    expect(rawStorage).not.toContain('22233344455');
    expect(rawStorage).not.toContain('Chinedu Okonkwo');
    expect(rawStorage).not.toContain('chinedu@example.com');
    expect(rawStorage).not.toContain('08039999999');
    expect(rawStorage).not.toContain('nin');
    expect(rawStorage).not.toContain('bvn');

    // Customer identifier (meter number) is safely preserved
    expect(rawStorage).toContain('62112345678');
  });
});

describe('terminal status check', () => {
  it('classifies completed, success, and delivered as terminal done', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('complete')).toBe(true);
    expect(isTerminalStatus('success')).toBe(true);
    expect(isTerminalStatus('delivered')).toBe(true);
  });

  it('classifies failed, refunded, reversed, cancelled as terminal failed', () => {
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('refunded')).toBe(true);
    expect(isTerminalStatus('reversed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
  });

  it('classifies pending, processing, queued as non-terminal', () => {
    expect(isTerminalStatus('pending')).toBe(false);
    expect(isTerminalStatus('processing')).toBe(false);
    expect(isTerminalStatus('queued')).toBe(false);
    expect(isTerminalStatus('initiated')).toBe(false);
  });
});

describe('rechecking non-terminal orders on next open', () => {
  it('re-checks only non-terminal orders and ignores terminal ones', async () => {
    await saveBillOrder({
      orderId: 'ord_terminal_done',
      customerRef: 'veil_ref',
      category: 'airtime',
      identifier: '08031111111',
      amount: 1000,
      asset: 'usdc',
      status: 'completed',
    });

    await saveBillOrder({
      orderId: 'ord_terminal_failed',
      customerRef: 'veil_ref',
      category: 'airtime',
      identifier: '08032222222',
      amount: 1000,
      asset: 'usdc',
      status: 'failed',
    });

    await saveBillOrder({
      orderId: 'ord_in_flight',
      customerRef: 'veil_ref',
      category: 'airtime',
      identifier: '08033333333',
      amount: 1000,
      asset: 'usdc',
      status: 'pending',
    });

    const mockGetStatus = jest.fn(async (_ref: string, orderId: string): Promise<BillStatus> => {
      return {
        orderId,
        customerRef: 'veil_ref',
        status: 'completed',
        billCategory: 'airtime',
        amountNgn: 1000,
        amountStableCoin: 0.67,
        wallet: 'GB3JS2AJZ3FKIGVOOPXDEYYR3XOHQA474WGCYAMNFSGX6OW5HGWCKUZW',
        description: 'MTN Airtime',
      };
    });

    await recheckPendingBillOrders({ getStatusFn: mockGetStatus });

    // Only the non-terminal order was queried
    expect(mockGetStatus).toHaveBeenCalledTimes(1);
    expect(mockGetStatus).toHaveBeenCalledWith('veil_ref', 'ord_in_flight');

    // The order now reflects the resolved status
    const resolved = await getBillOrder('ord_in_flight');
    expect(resolved?.status).toBe('completed');
  });

  it('tolerates network error on a single order without halting the rest', async () => {
    await saveBillOrder({
      orderId: 'ord_err',
      customerRef: 'veil_ref',
      category: 'airtime',
      identifier: '08031111111',
      amount: 500,
      status: 'pending',
    });

    await saveBillOrder({
      orderId: 'ord_ok',
      customerRef: 'veil_ref',
      category: 'airtime',
      identifier: '08032222222',
      amount: 500,
      status: 'pending',
    });

    const mockGetStatus = jest.fn(async (_ref: string, orderId: string) => {
      if (orderId === 'ord_err') throw new Error('504 Gateway Timeout');
      return {
        orderId,
        customerRef: 'veil_ref',
        status: 'completed',
        billCategory: 'airtime',
        amountNgn: 500,
        amountStableCoin: 0.33,
        wallet: 'GB3JS2AJZ3FKIGVOOPXDEYYR3XOHQA474WGCYAMNFSGX6OW5HGWCKUZW',
        description: 'Airtime',
      };
    });

    await recheckPendingBillOrders({ getStatusFn: mockGetStatus });

    const errOrder = await getBillOrder('ord_err');
    const okOrder = await getBillOrder('ord_ok');

    expect(errOrder?.status).toBe('pending');
    expect(okOrder?.status).toBe('completed');
  });
});

describe('a test proves a pending order resolves after a restart', () => {
  it('resolves a pending electricity order and retrieves its token after restart', async () => {
    // ── Phase 1: User places electricity order, app closes while pending ──
    const initialOrder = {
      orderId: 'ord_elec_pending_restart',
      customerRef: 'veil_restart_user',
      category: 'electricity' as const,
      provider: 'AEDC',
      identifier: '14123456789',
      amount: 4000,
      amountCrypto: 2.67,
      asset: 'usdc',
      status: 'pending', // Was pending when app closed
      time: Date.now() - 60_000,
      // No token yet!
    };
    await saveBillOrder(initialOrder);

    // Verify stored in pending state with no token
    let stored = await getBillOrder('ord_elec_pending_restart');
    expect(stored?.status).toBe('pending');
    expect(stored?.token).toBeUndefined();

    // ── Phase 2: App is restarted ──
    // Simulate re-opening the app. The backend now answers that the vend succeeded
    // and returns the prepaid token.
    const mockBackendOnRestart = jest.fn(async (ref: string, id: string): Promise<BillStatus> => {
      expect(ref).toBe('veil_restart_user');
      expect(id).toBe('ord_elec_pending_restart');
      return {
        orderId: id,
        customerRef: ref,
        status: 'completed',
        billCategory: 'electricity',
        amountNgn: 4000,
        amountStableCoin: 2.67,
        wallet: 'GB3JS2AJZ3FKIGVOOPXDEYYR3XOHQA474WGCYAMNFSGX6OW5HGWCKUZW',
        description: 'AEDC Prepaid Electricity ₦4,000',
        token: '5555-6666-7777-8888-9999', // The prepaid token generated while app was closed
      };
    });

    // App launch trigger: recheckPendingBillOrders runs on restart / open
    const refreshedOrders = await recheckPendingBillOrders({
      getStatusFn: mockBackendOnRestart,
    });

    // ── Phase 3: Assert order resolved to completed and token is retrievable ──
    const resolvedOrder = refreshedOrders.find((o) => o.orderId === 'ord_elec_pending_restart');
    expect(resolvedOrder).toBeDefined();
    expect(resolvedOrder?.status).toBe('completed');
    expect(resolvedOrder?.token).toBe('5555-6666-7777-8888-9999');

    // Also assert reading directly from persistent storage gives the resolved order and token
    const fromStorage = await getBillOrder('ord_elec_pending_restart');
    expect(fromStorage?.status).toBe('completed');
    expect(fromStorage?.token).toBe('5555-6666-7777-8888-9999');
  });
});

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
